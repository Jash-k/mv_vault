/**
 * tmdb.mjs — optional poster/rating/imdbId lookup.
 *
 * Used in two places:
 *   · after a scrape run, for the records that run touched;
 *   · by `--mode=tmdb`, the one-off backfill for records still missing artwork.
 *
 * Contract (`enrich`):
 *   { …meta }   → asked, found an exact title+year match (includes
 *                 original_language, which is what decides tamil vs tamil-dubbed)
 *   null        → asked, TMDB has no exact match (safe to remember as a miss)
 *   undefined   → could NOT ask (no key / rate-limited / auth rejected / network)
 *                 — never treat this as a miss, and never write bookkeeping for it.
 *
 * Only EXACT title+year matches are accepted; an ambiguous or partial match is
 * left alone rather than guessed. Series are searched on the TV endpoint first.
 */
const KEYS = String(process.env.TMDB_KEYS || process.env.TMDB_API_KEY || '')
  .split(',').map((k) => k.trim()).filter(Boolean);

export const hasKey = () => KEYS.length > 0;

let cursor = 0;
let cooldownUntil = 0;
let authFailed = false;
const rejected = new Set();

export const cooldownActive = () => Date.now() < cooldownUntil;
export const isAuthFailed = () => authFailed;

const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** One TMDB call. Returns { ok, data, reason }. */
async function api(path) {
  if (!KEYS.length) return { ok: false, reason: 'nokey' };
  if (Date.now() < cooldownUntil) return { ok: false, reason: 'cooldown' };
  if (authFailed) return { ok: false, reason: 'auth' };
  const url = `https://api.themoviedb.org/3${path}${path.includes('?') ? '&' : '?'}api_key=${KEYS[cursor]}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.status === 429) {
      cooldownUntil = Date.now() + 10 * 60_000;   // back off for the rest of this run
      await res.body?.cancel();
      return { ok: false, reason: 'cooldown' };
    }
    if (res.status === 401) {
      rejected.add(KEYS[cursor]);
      cursor = (cursor + 1) % KEYS.length;
      if (rejected.size >= KEYS.length) authFailed = true;
      await res.body?.cancel();
      return { ok: false, reason: 'auth' };
    }
    if (!res.ok) { await res.body?.cancel(); return { ok: false, reason: `http ${res.status}` }; }
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: 'network' };
  }
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

async function lookup(title, year, type) {
  const params = new URLSearchParams({ query: title });
  if (year) params.set(type === 'tv' ? 'first_air_date_year' : 'year', String(year));
  const search = await api(`/search/${type}?${params}`);
  if (!search.ok) return { asked: false };
  const hit = pick(search.data?.results, { title, year }, type);
  if (!hit) return { asked: true, meta: null };
  const details = await api(`/${type}/${hit.id}?append_to_response=external_ids`);
  if (!details.ok) return { asked: false };
  if (!details.data?.id) return { asked: true, meta: null };
  return {
    asked: true,
    meta: {
      tmdbId: details.data.id,
      tmdbType: type,
      imdbId: details.data.external_ids?.imdb_id || '',
      poster: details.data.poster_path ? `https://image.tmdb.org/t/p/w500${details.data.poster_path}` : '',
      rating: Number(details.data.vote_average) || 0,
      originalLanguage: details.data.original_language || '',
    },
  };
}

/** Details straight from a known TMDB id — cheaper and exact. */
async function lookupById(id, type) {
  const details = await api(`/${type}/${id}?append_to_response=external_ids`);
  if (!details.ok) return { asked: false };
  if (!details.data?.id) return { asked: true, meta: null };
  return {
    asked: true,
    meta: {
      tmdbId: details.data.id,
      tmdbType: type,
      imdbId: details.data.external_ids?.imdb_id || '',
      poster: details.data.poster_path ? `https://image.tmdb.org/t/p/w500${details.data.poster_path}` : '',
      rating: Number(details.data.vote_average) || 0,
      originalLanguage: details.data.original_language || '',
    },
  };
}

/**
 * { poster, rating, tmdbId, imdbId, originalLanguage } | null (no exact match) |
 * undefined (could not ask).
 *
 * A record that already carries a tmdbId is looked up BY THAT ID — one call, and
 * it cannot pick up a different film with a similar title (which is exactly how
 * a title-year search can return the wrong original_language). Only records with
 * no tmdbId fall back to an exact title+year search.
 */
export async function enrich({ title, year, kind, tmdbId = 0 }) {
  if (!hasKey() || authFailed || cooldownActive()) return undefined;
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

  const attempt = await lookup(title, year, first);
  if (!attempt.asked) return undefined;
  if (attempt.meta) return attempt.meta;
  const fallback = await lookup(title, year, second);
  if (!fallback.asked) return undefined;
  return fallback.meta || null;
}
