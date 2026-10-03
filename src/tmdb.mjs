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
 * Contract (`enrich`):
 *   { …meta }   → asked, found an exact title+year match (includes
 *                 original_language, which is what decides tamil vs tamil-dubbed)
 *   null        → asked, TMDB has no exact match (safe to remember as a miss)
 *   undefined   → could NOT ask (no key / all keys parked / auth rejected /
 *                 network) — never treat this as a miss, never write bookkeeping.
 *
 * Only EXACT title+year matches are accepted; an ambiguous or partial match is
 * left alone rather than guessed. A record that already carries a tmdbId is
 * looked up BY THAT ID (one call, and it cannot pick up a different film).
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

const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** One attempt on one key. */
async function attempt(path, key) {
  const url = `https://api.themoviedb.org/3${path}${path.includes('?') ? '&' : '?'}api_key=${key}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
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

/** The one exact title+year match, or null when there is none / more than one. */
function pick(results, { title, year }, type) {
  const wanted = normalise(title);
  const exact = (results || []).filter((r) => [r.title, r.original_title, r.name, r.original_name]
    .some((t) => normalise(t) === wanted));
  const sameYear = year ? exact.filter((r) => yearOf(r, type) === Number(year)) : exact;
  return sameYear.length === 1 ? sameYear[0] : null;
}

const metaOf = (details, type) => ({
  tmdbId: details.id,
  tmdbType: type,
  imdbId: details.external_ids?.imdb_id || '',
  poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '',
  rating: Number(details.vote_average) || 0,
  originalLanguage: details.original_language || '',
});

async function lookupById(id, type) {
  const details = await api(`/${type}/${id}?append_to_response=external_ids`);
  if (!details.ok) return { asked: false };
  if (!details.data?.id) return { asked: true, meta: null };
  return { asked: true, meta: metaOf(details.data, type) };
}

async function lookup(title, year, type) {
  const params = new URLSearchParams({ query: title });
  if (year) params.set(type === 'tv' ? 'first_air_date_year' : 'year', String(year));
  const search = await api(`/search/${type}?${params}`);
  if (!search.ok) return { asked: false };
  const hit = pick(search.data?.results, { title, year }, type);
  if (!hit) return { asked: true, meta: null };
  return lookupById(hit.id, type);
}

/** { poster, rating, tmdbId, imdbId, originalLanguage } | null | undefined. */
export async function enrich({ title, year, kind, tmdbId = 0 }) {
  if (!hasKey() || allKeysDown()) return undefined;
  const first = kind === 'series' ? 'tv' : 'movie';
  const second = first === 'tv' ? 'movie' : 'tv';

  if (Number(tmdbId) > 0) {
    for (const type of [first, second]) {
      const byId = await lookupById(Number(tmdbId), type);
      if (!byId.asked) return undefined;
      if (byId.meta) return byId.meta;
    }
    // the id no longer resolves → fall through to a title search
  }

  const primary = await lookup(title, year, first);
  if (!primary.asked) return undefined;
  if (primary.meta) return primary.meta;
  const fallback = await lookup(title, year, second);
  if (!fallback.asked) return undefined;
  return fallback.meta || null;
}
