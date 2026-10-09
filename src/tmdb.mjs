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
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.status === 404) { await res.body?.cancel(); return { ok: false, reason: 'missing' }; }
    if (res.status === 429) { await res.body?.cancel(); return { ok: false, reason: 'cooldown' }; }
    if (res.status === 401 || res.status === 403) { await res.body?.cancel(); return { ok: false, reason: 'auth' }; }
    if (!res.ok) { await res.body?.cancel(); return { ok: false, reason: `http ${res.status}` }; }
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/** One TMDB call: rotates keys on a throttle/rejection, retries a network blip once. */
async function api(path) {
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
      if (result.reason === 'network') return result; // real network trouble
      i -= 1;                                       // a throttle on the retry still rotates
      last = result;
      continue;
    }
    return result;                                  // http 5xx and anything else
  }
  return last;
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
  if (year) params.set(type === 'tv' ? 'first_air_date_year' : 'year', String(year));
  const found = new Map();
  for (let page = 1; page <= 5; page += 1) {
    params.set('page', String(page));
    const reply = await api(`/search/${type}?${params}`);
    if (!reply.ok) return { asked: false };
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
  // A literal search for 'Business Man' does not return 'Businessman'. Search
  // both forms, union candidates, then enforce exactly one verified match.
  const variants = [...new Set([query, query.replace(/['’]/g, ''), normalise(query)])];
  for (const variant of variants) {
    const search = await searchAll(variant, type, type === 'movie' ? year : 0);
    if (!search.asked) return { asked: false };
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
    candidates.push(metaOf(details, type, match, record));
  }
  return { asked: true, meta: candidates.length === 1 ? candidates[0] : null };
}

export async function enrich(record) {
  if (!hasKey() || allKeysDown()) return undefined;
  const { title, kind, tmdbId = 0, verifyIds = false } = record;
  const first = record.tmdbType || (kind === 'series' || /series$/.test(record.category || '') ? 'tv' : 'movie');
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
  const names = (p) => [p.name, p.original_name, ...(p.also_known_as || [])].filter(Boolean).map(normalise);
  const cast = new Set((details.credits?.cast || []).slice(0, 15).flatMap(names));
  const directors = new Set((details.credits?.crew || []).filter(p => p.job === 'Director').flatMap(names));
  const castMatches = (evidence.cast || []).filter(n => cast.has(normalise(n)));
  const directorMatches = (evidence.directors || []).filter(n => directors.has(normalise(n)));
  return { castMatches, directorMatches,
    strong: castMatches.length >= 2 || (castMatches.length >= 1 && directorMatches.length >= 1),
    contradiction: (evidence.cast || []).length >= 2 && cast.size > 0 && castMatches.length === 0 };
}

// Small spelling changes are candidate evidence ONLY when independently
// corroborated by two cast names or a director+cast, never on their own.
export function titleSimilarity(a, b) {
  a = normalise(a); b = normalise(b);
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
  const reply = await api(`/${type}/${id}?append_to_response=external_ids,alternative_titles,translations,credits,release_dates`);
  return reply.ok ? {asked:true,details:reply.data} : {asked:false};
}

export async function validateCredits(meta, evidence) {
  const result=await creditedDetails(meta.tmdbId, meta.tmdbType);
  if(!result.asked || !result.details?.id) return undefined;
  return creditEvidence(result.details,evidence);
}

/** Safe second pass: source credits plus exact/official alias or close spelling.
 * No credit-only matches, no popularity tie-break, no guessed translated title.
 * Public for repeatable metadata-only backfill scripts; episode data untouched.
 */
export async function enrichWithEvidence(record, evidence) {
  if(!evidence?.available || record.kind==='series' || !(evidence.cast||[]).length) return null;
  const type='movie';
  const query=record.title;
  const candidates=new Map();
  let search=await searchAll(query,type);
  const broadTruncated = search.reason === 'too-many-candidates';
  if(broadTruncated) search=await searchAll(query,type,Number(evidence.sourceYear||record.year)||0);
  if(!search.asked) return undefined;
  for(const h of search.hits)candidates.set(h.id,h);
  // Exact lead-actor identity supplies candidates for transliteration spellings
  // the title search cannot retrieve. Never choose the most popular person.
  if(evidence.cast[0]) {
    const people=await api(`/search/person?query=${encodeURIComponent(evidence.cast[0])}`);
    if(!people.ok) return undefined;
    const exact=(people.data?.results||[]).filter(p=>normalise(p.name)===normalise(evidence.cast[0]));
    if(exact.length===1 && (people.data.total_pages||1)===1) {
      const credits=await api(`/person/${exact[0].id}/movie_credits`);
      if(!credits.ok)return undefined;
      for(const h of credits.data?.cast||[])candidates.set(h.id,h);
    }
  }
  const sourceYear=Number(evidence.sourceYear||record.year)||0;
  const accepted=[];
  for(const hit of candidates.values()) {
    const y=yearOf(hit,type);
    if(sourceYear && y && y>sourceYear+1)continue;
    // Narrow expensive detail calls; exact official translations may be hidden
    // in search results, so retain the entire literal-search candidate set too.
    const visible=titlesOf(hit).some(t=>titleSimilarity(query,t)>=0.84);
    if(!visible && !search.hits.some(h=>h.id===hit.id))continue;
    const result=await creditedDetails(hit.id,type);
    if(!result.asked)return undefined;
    const d=result.details;if(!d?.id)continue;
    const titleScore=Math.max(...namesOf(d).map(t=>titleSimilarity(query,t)),0);
    const credits=creditEvidence(d,evidence);
    if(titleScore<0.84 || !credits.strong || credits.contradiction)continue;
    if(titleScore<1 && sourceYear && y && Math.abs(sourceYear-y)>2)continue;
    accepted.push({...metaOf(d,type,titleScore===1?'title-and-source-credits':'spelling-and-source-credits'),evidence:{sourceUrl:evidence.sourceUrl,sourceYear,castMatches:credits.castMatches,directorMatches:credits.directorMatches,titleScore}});
  }
  return accepted.length===1?accepted[0]:broadTruncated?undefined:null;
}
