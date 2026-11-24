/**
 * tmdb.mjs — optional poster/rating/category lookup, with multi-key rotation.
 *
 * Used in two places:
 *   · after a scrape run, for the records that run touched;
 *   · by `--mode=enrich`, the backfill for records missing artwork/category.
 *
 * KEY ROTATION
 *   TMDB rate-limits per key (and per IP), so a comma-separated key list is a
 *   pool: every request goes out on the next usable key round-robin. A 429 parks
 *   that ONE key for 10 minutes and the request is retried on the next key; a 401
 *   retires that key. The run only stops when every key is parked/retired — with
 *   11 keys that means one throttled key costs nothing.
 *
 * Contract: metadata = verified match, null = completed search with no safe
 * match, undefined = unavailable/incomplete search (never remember as a miss).
 * Matches use exact canonical titles or official TMDB alternatives, with movie
 * release year or TV season-air year evidence. Small spelling differences need
 * independent cast/director corroboration; never accept fuzzy titles alone.
 */
import { lookupContext, noteLookup } from './lookup-context.mjs';

const KEYS = String(process.env.TMDB_KEYS || process.env.TMDB_API_KEY || '')
  .split(',').map((k) => k.trim()).filter(Boolean);

export const hasKey = () => KEYS.length > 0;
export const keyCount = () => KEYS.length;

const COOLDOWN_MS = 10 * 60_000;
const state = KEYS.map((key) => ({ key, dead: false, parkedUntil: 0 }));
let cursor = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const liveKeys = () => state.filter((k) => !k.dead && Date.now() >= k.parkedUntil).length;
export const allKeysDown = () => hasKey() && liveKeys() === 0;
export const allKeysDead = () => hasKey() && state.every((k) => k.dead);
/** Kept for the run summary. */
export const isAuthFailed = () => allKeysDead();
export const cooldownActive = () => allKeysDown() && !allKeysDead();
export const keyStatus = () => {
  const parked = state.filter((k) => !k.dead && Date.now() < k.parkedUntil).length;
  const dead = state.filter((k) => k.dead).length;
  return `${state.length} key${state.length > 1 ? 's' : ''}${parked ? ` · ${parked} parked` : ''}${dead ? ` · ${dead} rejected` : ''}`;
};

/** Next usable key, round-robin. Null when every key is parked or dead. */
function nextKey() {
  for (let i = 0; i < state.length; i += 1) {
    const entry = state[(cursor + i) % state.length];
    if (!entry.dead && Date.now() >= entry.parkedUntil) {
      cursor = (cursor + i + 1) % state.length;
      return entry;
    }
  }
  return null;
}

export const normalise = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
  .replace(/(?<=\d)\.(?=\d)/g, 'decimalpoint')
  .replace(/[^\p{L}\p{N}]+/gu, '');
const titlesOf = (r) => [r.title, r.original_title, r.name, r.original_name].filter(Boolean);

/** One attempt on one key. */
async function attempt(path, key) {
  const url = `https://api.themoviedb.org/3${path}${path.includes('?') ? '&' : '?'}api_key=${key}`;
  try {
    const context = lookupContext();
    if (context?.signal.aborted) return { ok: false, reason: 'lookup-timeout' };
    if (context && context.requests >= context.maxRequests) return { ok: false, reason: 'request-budget' };
    if (context) context.requests += 1;
    const signal = context ? AbortSignal.any([context.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    const res = await fetch(url, { signal });
    if (res.status === 404) { await res.body?.cancel(); return { ok: false, reason: 'missing' }; }
    if (res.status === 429) { await res.body?.cancel(); return { ok: false, reason: 'cooldown' }; }
    if (res.status === 401 || res.status === 403) { await res.body?.cancel(); return { ok: false, reason: 'auth' }; }
    if (!res.ok) { await res.body?.cancel(); return { ok: false, reason: `http ${res.status}` }; }
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: lookupContext()?.signal.aborted ? 'lookup-timeout' : 'network' };
  }
}

/** One TMDB call: rotates keys on a throttle/rejection, retries a network blip once. */
async function requestApi(path) {
  if (!KEYS.length) return { ok: false, reason: 'nokey' };
  const tries = Math.min(Math.max(state.length, 1), 4); // at most 4 different keys per call
  let last = { ok: false, reason: 'cooldown' };
  for (let i = 0; i < tries; i += 1) {
    const entry = nextKey();
    if (!entry) return { ok: false, reason: state.every((k) => k.dead) ? 'auth' : 'cooldown' };
    let result = await attempt(path, entry.key);
    if (result.ok) return result;

    if (result.reason === 'cooldown') {
      entry.parkedUntil = Date.now() + COOLDOWN_MS; // this key only
      last = result;
      continue;                                     // next key
    }
    if (result.reason === 'auth') {
      entry.dead = true;                            // this key only
      last = result;
      continue;
    }
    if (result.reason === 'missing') return { ok: true, data: null }; // a real answer: nothing at this path
    if (result.reason === 'network') {
      await sleep(700);
      result = await attempt(path, entry.key);      // same key, one retry
      if (result.ok) return result;
      if (result.reason === 'cooldown') entry.parkedUntil = Date.now() + COOLDOWN_MS;
      else if (result.reason === 'auth') entry.dead = true;
      else if (result.reason === 'missing') return { ok: true, data: null };
      else return result;
      last = result;
      continue;
    }
    return result;                                  // http 5xx and anything else
  }
  return last;
}

async function api(path) {
  const ctx = lookupContext();
  if (ctx?.signal.aborted) { noteLookup('lookup-timeout'); return { ok: false, reason: 'lookup-timeout' }; }
  if (ctx?.cache.has(path)) return ctx.cache.get(path);
  const result = await requestApi(path);
  if (result.ok) ctx?.cache.set(path, result);
  else noteLookup(`tmdb-${result.reason.replace(/\s+/g, '-')}`);
  return result;
}

const yearOf = (hit, type) => Number(String((type === 'tv' ? hit.first_air_date : hit.release_date) || '').slice(0, 4)) || 0;
const namesOf = (details) => [
  ...titlesOf(details),
  ...(details.alternative_titles?.titles || details.alternative_titles?.results || []).map((r) => r.title),
  ...(details.translations?.translations || []).flatMap((r) => [r.data?.title, r.data?.name]),
].filter(Boolean);

const posterFor = (details, type, record = {}) => {
  if (type === 'tv') {
    const declared = Number(String(record.title || '').match(/season\s*(\d+)\s*\)?$/i)?.[1] || 0);
    const numbers = [...new Set((record.seasons || []).map(s => Number(s.season)).filter(n => n > 0))];
    const season = declared || (numbers.length === 1 ? numbers[0] : 0);
    const poster = (details.seasons || []).find(s => s.season_number === season)?.poster_path;
    if (poster) return poster;
  }
  return details.poster_path;
};
const metaOf = (details, type, match = 'stored-id', record = {}) => ({
  tmdbId: details.id, tmdbType: type,
  tmdbTitle: details.title || details.name || '',
  imdbId: details.external_ids?.imdb_id || '',
  poster: posterFor(details, type, record) ? `https://image.tmdb.org/t/p/w500${posterFor(details, type, record)}` : '',
  rating: Number(details.vote_average) || 0,
  originalLanguage: details.original_language || '',
  match, originalYear: yearOf(details, type),
});

async function detailsById(id, type) {
  const reply = await api(`/${type}/${id}?append_to_response=external_ids,alternative_titles,translations`);
  return reply.ok ? { asked: true, details: reply.data } : { asked: false };
}

// Search every page within a hard bound. A truncated/network-failed search is
// unavailable, NOT evidence of a unique match and NOT a remembered miss.
async function searchAll(title, type, year = 0) {
  const params = new URLSearchParams({ query: title, include_adult: 'false' });
  // For TV, `year` includes episode air dates; first_air_date_year loses later seasons.
  if (year) params.set('year', String(year));
  const found = new Map();
  for (let page = 1; page <= 5; page += 1) {
    params.set('page', String(page));
    const reply = await api(`/search/${type}?${params}`);
    if (!reply.ok) return { asked: false, reason: reply.reason };
    if (Number(reply.data?.total_pages) > 5) return { asked: false, reason: 'too-many-candidates' };
    for (const hit of reply.data?.results || []) found.set(hit.id, hit);
    if (page >= (Number(reply.data?.total_pages) || 1)) return { asked: true, hits: [...found.values()] };
  }
  return { asked: false };
}

async function lookup(record, type) {
  const { title, year, seasons = [], originalLanguage = '' } = record;
  const query = type === 'tv' ? title.replace(/\s*(?:\(|-)?\s*season\s*\d+\s*\)?$/i, '').trim() : title;
  if (!normalise(query)) return { asked: true, meta: null };
  const wanted = normalise(query);
  // Unfiltered TV search is essential: the stored year is often season 2/3/10,
  // not first_air_date_year. Movie year remains mandatory.
  const all = new Map();
  let yearScoped = false;
  // A literal search for 'Business Man' does not return 'Businessman'. Search
  // both forms, union candidates, then enforce exactly one verified match.
  const variants = [...new Set([query, query.replace(/['’]/g, ''), normalise(query)])];
  for (const variant of variants) {
    let search = await searchAll(variant, type, type === 'movie' ? year : 0);
    if (!search.asked && search.reason === 'too-many-candidates' && type === 'tv' && year) {
      yearScoped = true;
      noteLookup('tv-search-year-scoped', { year: Number(year) });
      search = await searchAll(variant, type, year);
    }
    if (!search.asked) {
      if (search.reason === 'too-many-candidates') noteLookup('candidate-scope-truncated', { type, year: Number(year) || 0 });
      return { asked: false };
    }
    for (const hit of search.hits) all.set(hit.id, hit);
  }
  const hits = [...all.values()].filter((r) => type === 'tv' || !year || yearOf(r, type) === Number(year));
  const candidates = [];
  for (const hit of hits) {
    // Check official aliases/translations too, including every plausible result.
    const result = await detailsById(hit.id, type);
    if (!result.asked) return { asked: false };
    const details = result.details;
    if (!details?.id || !namesOf(details).some((n) => normalise(n) === wanted)) continue;
    if (originalLanguage && details.original_language !== originalLanguage) continue;
    let match = titlesOf(details).some((n) => normalise(n) === wanted) ? 'exact-title-year' : 'official-alias-year';
    if (type === 'movie' && year && yearOf(details, type) !== Number(year)) continue;
    if (type === 'tv' && year && yearOf(details, type) !== Number(year)) {
      const explicit = Number(title.match(/season\s*(\d+)\s*\)?$/i)?.[1] || 0);
      const numbers = new Set(seasons.map((s) => Number(s.season)).filter((n) => n > 0));
      if (explicit) numbers.add(explicit);
      if (!numbers.size || !(details.seasons || []).some((s) => numbers.has(s.season_number) && Number(String(s.air_date || '').slice(0, 4)) === Number(year))) continue;
      match = 'exact-title-season-year';
    }
    // Regional reality franchises share an English title. A Tamil dub site is
    // NOT evidence of original language; require explicit evidence from caller.
    if (type === 'tv' && /^(biggboss|bigsister|bigbrother|survivor|thevoice|idols?|supersinger|masterchef|kodeeswari)$/.test(wanted) && !originalLanguage) continue;
    candidates.push({ ...metaOf(details, type, match, record), ...(yearScoped ? { searchScope: 'episode-year' } : {}) });
  }
  if (candidates.length > 1) noteLookup('ambiguous-title-year', { count: candidates.length, type });
  else if (!candidates.length) noteLookup('no-title-year-match', { type });
  return { asked: true, meta: candidates.length === 1 ? candidates[0] : null };
}

export async function enrich(record) {
  if (!hasKey() || allKeysDown()) { noteLookup(!hasKey() ? 'tmdb-nokey' : allKeysDead() ? 'tmdb-auth' : 'tmdb-cooldown'); return undefined; }
  if (record.metadataOverride) return enrichOverride(record);
  const { title, kind, tmdbId = 0, verifyIds = false } = record;
  const first = kind === 'series' || /series$/.test(record.category || '') ? 'tv' : record.tmdbType || 'movie';
  const second = first === 'tv' ? 'movie' : 'tv';
  if (Number(tmdbId) > 0) {
    const result = await detailsById(Number(tmdbId), first);
    if (!result.asked) return undefined;
    if (result.details?.id) {
      const query = first === 'tv' ? title.replace(/\s*season\s*\d+\s*$/i, '').trim() : title;
      if (!verifyIds || namesOf(result.details).some((n) => normalise(n) === normalise(query))) return metaOf(result.details, first, 'stored-id', record);
      // An ID suspected of belonging to a different work must NEVER feed its
      // poster/language back into this record when no replacement can be found.
    }
  }
  const primary = await lookup(record, first);
  if (!primary.asked) return undefined;
  if (primary.meta) return primary.meta;
  if (second === 'tv') {
    const fallback = await lookup(record, second);
    if (!fallback.asked) return undefined;
    if (fallback.meta) return { ...fallback.meta, crossType: Boolean(tmdbId) };
  }
  return null;
}

/** Credits are corroboration, never a replacement for title identity. */
export function creditEvidence(details, evidence = {}) {
  const names = p => [p.name, p.original_name, ...(p.also_known_as || [])].filter(Boolean).map(normalise);
  const credited = details.aggregate_credits || details.credits || {};
  const cast = (credited.cast || []).slice(0, 20);
  const directors = [...(credited.crew || []).filter(p => p.job === 'Director' || (p.jobs || []).some(j => j.job === 'Director')),
    ...(details.created_by || [])];
  const matches = (people, source) => {
    const used = new Set();
    return [...new Set(source || [])].filter(name => {
      const n = normalise(name);
      const at = people.findIndex(p => names(p).includes(n));
      if (at < 0) return false;
      const id = people[at].id || `name:${names(people[at])[0]}`;
      if (used.has(id)) return false;
      used.add(id); return true;
    });
  };
  const castMatches = matches(cast, evidence.cast);
  const directorMatches = matches(directors, evidence.directors);
  const matchedIds = (people, found) => found.map(n => { const p = people.find(p => names(p).includes(normalise(n))); return p?.id ? `id:${p.id}` : `name:${names(p || {})[0]}`; });
  const distinct = new Set([...matchedIds(cast, castMatches), ...matchedIds(directors, directorMatches)]);
  return { castMatches, directorMatches,
    strong: distinct.size >= 2 && (castMatches.length >= 2 || (castMatches.length >= 1 && directorMatches.length >= 1)),
    contradiction: (evidence.cast || []).length >= 2 && cast.length > 0 && castMatches.length === 0 };
}

// Small spelling changes are candidate evidence ONLY when independently
// corroborated by two cast names or a director+cast, never on their own.
const numberIdentity = value => {
  const nums = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9 };
  return String(value).toLowerCase().replace(/\b(part|chapter|season)\s+i\b/g, '$1 1')
    .replace(/\b(part|chapter|season)\s+v\b/g, '$1 5')
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|ii|iii|iv|vi|vii|viii|ix)\b/g, w => String(nums[w]));
};
export function titleSimilarity(a, b) {
  a = normalise(numberIdentity(a)); b = normalise(numberIdentity(b));
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 8) return 0;
  if ((a.match(/\d+/g)||[]).join() !== (b.match(/\d+/g)||[]).join()) return 0;
  let prev = Array.from({length:b.length+1},(_,i)=>i);
  for (let i=1;i<=a.length;i++) {
    const row=[i];
    for (let j=1;j<=b.length;j++) row[j]=Math.min(row[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    prev=row;
  }
  return 1-prev[b.length]/Math.max(a.length,b.length);
}

async function creditedDetails(id, type) {
  const extras = type === 'tv' ? 'aggregate_credits' : 'credits,release_dates';
  const reply = await api(`/${type}/${id}?append_to_response=external_ids,alternative_titles,translations,${extras}`);
  return reply.ok ? {asked:true,details:reply.data} : {asked:false};
}

export async function validateCredits(meta, evidence) {
  const result=await creditedDetails(meta.tmdbId, meta.tmdbType);
  if(!result.asked || !result.details?.id) return undefined;
  return creditEvidence(result.details,evidence);
}

/** Official subtitle abbreviation is candidate evidence, not a match by itself.
 * Digits in the base title are never removed (Scam 2003 is NOT Scam 1992).
 */
export function subtitleCandidate(query, title) {
  const base = String(query).trim().toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const full = String(title).trim().toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return normalise(base).length >= 8 && full.startsWith(`${base} `);
}

async function distinctiveCastIdentity(details, evidence) {
  const c = details.aggregate_credits || details.credits || {};
  const candidates = [...(evidence.cast || []).slice(0, 4).map(name => ({ name, people: c.cast || [] })),
    ...(evidence.directors || []).slice(0, 2).map(name => ({ name, people: [
      ...(c.crew || []).filter(p => p.job === 'Director' || (p.jobs || []).some(j => j.job === 'Director')), ...(details.created_by || []),
    ] }))];
  const verified = new Map();
  for (const { name, people: cast } of candidates) {
    const wanted = normalise(name);
    const credited = cast.filter(p => [p.name, p.original_name, ...(p.also_known_as || [])].some(n => normalise(n) === wanted));
    if (credited.length !== 1 || !credited[0].id) continue;
    const people = await api(`/search/person?query=${encodeURIComponent(name)}`);
    if (!people.ok) return undefined;
    const exact = (people.data?.results || []).filter(p => normalise(p.name) === wanted);
    if ((people.data.total_pages || 1) === 1 && exact.length === 1 && exact[0].id === credited[0].id) verified.set(exact[0].id, { name, personId: exact[0].id });
    if (verified.size >= 2) return [...verified.values()];
  }
  return null;
}

/** Source credits support TV as well as films; playback is never reshaped.
 * Every retrieved candidate is considered. A partial search is never called
 * unique, and all weaker title/year matches require independent strong credits.
 */
export async function enrichWithEvidence(record, evidence) {
  if (!evidence?.available || !(evidence.cast || []).length) return null;
  const type = record.kind === 'series' || record.tmdbType === 'tv' || /series$/.test(record.category || '') ? 'tv' : 'movie';
  const query = type === 'tv' ? record.title.replace(/\s*(?:\(|-)?\s*season\s*\d+\s*\)?$/i, '').trim() : record.title;
  const sourceYear = Number(evidence.sourceYear || record.year) || 0;
  let search = await searchAll(query, type);
  const scoped = search.reason === 'too-many-candidates';
  if (scoped && sourceYear) search = await searchAll(query, type, sourceYear);
  if (!search.asked) {
    if (search.reason === 'too-many-candidates') noteLookup('candidate-scope-truncated', { type });
    return undefined;
  }
  const candidates = new Map(search.hits.map(h => [h.id, h]));
  const literalIds = new Set(search.hits.map(h => h.id));
  let expansionPerson = '';
  if (type === 'tv' && /^(biggboss|bigsister|bigbrother|survivor|thevoice|idols?|supersinger|masterchef|kodeeswari)$/.test(normalise(query)) && !record.originalLanguage) {
    noteLookup('regional-franchise-needs-review'); return null;
  }
  // Candidate expansion through a uniquely named lead actor; never select the
  // most popular person. Credit identity still does not replace title evidence.
  if (evidence.cast[0]) {
    const people = await api(`/search/person?query=${encodeURIComponent(evidence.cast[0])}`);
    if (!people.ok) return undefined;
    const exact = (people.data?.results || []).filter(p => normalise(p.name) === normalise(evidence.cast[0]));
    if (exact.length === 1 && (people.data.total_pages || 1) === 1) {
      const credits = await api(`/person/${exact[0].id}/${type === 'tv' ? 'tv' : 'movie'}_credits`);
      if (!credits.ok) return undefined;
      expansionPerson = evidence.cast[0];
      for (const h of credits.data?.cast || []) candidates.set(h.id, h);
    }
  }
  const accepted = [];
  const exactRivals = new Set();
  for (const hit of candidates.values()) {
    const visible = titlesOf(hit).some(t => titleSimilarity(query, t) >= 0.84 || subtitleCandidate(query, t));
    if (!visible && !search.hits.some(h => h.id === hit.id)) continue;
    const result = await creditedDetails(hit.id, type);
    if (!result.asked) return undefined;
    const d = result.details;
    if (!d?.id) continue;
    if (record.originalLanguage && !record.verifyIds && d.original_language !== record.originalLanguage) continue;
    const names = namesOf(d);
    const titleScore = Math.max(...names.map(t => titleSimilarity(query, t)), 0);
    const exactTitle = names.some(t => normalise(query) === normalise(t));
    const prefix = names.some(t => subtitleCandidate(query, t));
    const independent = !literalIds.has(hit.id) && expansionPerson ? { ...evidence, cast: evidence.cast.filter(n => normalise(n) !== normalise(expansionPerson)), directors: evidence.directors.filter(n => normalise(n) !== normalise(expansionPerson)) } : evidence;
    const credits = creditEvidence(d, independent);
    if (exactTitle) exactRivals.add(d.id);
    if ((titleScore < 0.84 && !prefix) || !credits.strong || credits.contradiction) continue;
    // Scoped/truncated search is not evidence of global uniqueness for weaker
    // titles. Franchise siblings share casts, so never choose a subtitle here.
    if (scoped && !exactTitle) continue;
    if (!exactTitle && [...candidates.values()].some(other => other.id !== hit.id && titlesOf(other).some(t =>
      subtitleCandidate(query, t) || titleSimilarity(query, t) >= 0.84))) continue;
    const years = [yearOf(d, type), ...(type === 'tv' ? (d.seasons || []).map(s => Number(String(s.air_date || '').slice(0, 4))) : [])].filter(Boolean);
    const distance = sourceYear && years.length ? Math.min(...years.map(y => Math.abs(sourceYear - y))) : Infinity;
    // Official title + strong credits may identify a much later dubbed release.
    // Spelling/subtitle relaxations allow only a small year difference.
    if (!exactTitle && distance > 2) continue;
    // A dub year is not evidence that a truncated TV search was complete for
    // the work. Restrict scoped recovery to an original/season year, not air span.
    const explicitSeason = Number(`${record.title} ${evidence.sourceTitle || ''}`.match(/\bseason\s*(\d+)\b/i)?.[1] || 0);
    const scopedYearOk = yearOf(d, type) === sourceYear || (type === 'tv' && explicitSeason > 0 &&
      (d.seasons || []).some(s => s.season_number === explicitSeason && Number(String(s.air_date || '').slice(0, 4)) === sourceYear));
    if (scoped && !scopedYearOk) continue;
    let distinctive;
    if (scoped) {
      distinctive = await distinctiveCastIdentity(d, independent);
      if (distinctive === undefined) return undefined;
      if (!distinctive) { noteLookup('scoped-credit-identity-ambiguous'); continue; }
    }
    if (sourceYear && years.length && Math.min(...years) > sourceYear + 1) continue;
    const match = exactTitle ? 'title-and-source-credits' : prefix ? 'subtitle-and-source-credits' : 'spelling-and-source-credits';
    accepted.push({ ...metaOf(d, type, match, record), evidence: { sourceUrl: evidence.sourceUrl, sourceYear,
      castMatches: credits.castMatches, directorMatches: credits.directorMatches, titleScore,
      ...(scoped ? { searchScope: 'year-scoped-with-credits', distinctive, explicitSeason, firstAirYear: yearOf(d, type) } : {}) } });
  }
  if (scoped && (accepted.length !== 1 || exactRivals.size !== 1)) { noteLookup('scoped-search-needs-review'); return undefined; }
  if (accepted.length > 1) noteLookup('ambiguous-source-credits', { count: accepted.length, type });
  else if (!accepted.length) noteLookup('no-corroborated-match', { type });
  return accepted.length === 1 ? accepted[0] : null;
}

/** Explicit human-reviewed mappings, validated against TMDB, never guessed IDs.
 * A wrong source page may only be bypassed through this auditable path.
 */
async function enrichOverride(record) {
  const o = record.metadataOverride;
  if (!Number.isInteger(o.tmdbId) || o.tmdbId < 1 || !['movie', 'tv'].includes(o.tmdbType) ||
    !o.expectedTitle || !o.reason || !Array.isArray(o.evidenceUrls) || !o.evidenceUrls.length ||
    (record.kind === 'series' && o.tmdbType !== 'tv')) {
    noteLookup('override-conflict'); return null;
  }
  const result = await detailsById(o.tmdbId, o.tmdbType);
  if (!result.asked) return undefined;
  if (!result.details?.id || !namesOf(result.details).some(t => normalise(t) === normalise(o.expectedTitle))) {
    noteLookup('override-conflict'); return null;
  }
  return { ...metaOf(result.details, o.tmdbType, 'reviewed-override', record),
    evidence: { reason: o.reason, evidenceUrls: o.evidenceUrls } };
}
