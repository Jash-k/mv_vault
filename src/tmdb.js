/**
 * TMDB enrichment with KEY ROTATION and match guarding.
 *
 * Set TMDB_KEYS (comma-separated) — each lookup uses the next key in the pool;
 * a 401/404/429 or network error rotates to the next key immediately and retries
 * once, so one exhausted key never stalls the run. All failures degrade
 * gracefully: the record simply keeps its poster-less shape.
 *
 * Matching is GUARDED. `search/movie` returns popular results even when nothing
 * matches, so taking results[0] blindly is how a catalog ends up with the wrong
 * poster on a Tamil film. A candidate must match the title (and the year, when
 * both are known) or it is rejected — no poster beats a wrong poster.
 *
 * TMDB_BASE overrides the API host (used by the test harness; you should not
 * need it).
 */

const BASE = String(process.env.TMDB_BASE || 'https://api.themoviedb.org/3').replace(/\/+$/, '');

const keys = String(process.env.TMDB_KEYS || process.env.TMDB_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

let cursor = 0;
let lastFailureAt = 0;
const REDIRECT_HINT = 'https://image.tmdb.org/t/p/w500';

export function keyCount() {
  return keys.length;
}

/** Pause TMDB lookups briefly after repeated failures (be nice on 429s). */
function backoffIfHot() {
  if (keys.length > 1) return;
  if (Date.now() - lastFailureAt < 4000) {
    return new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

function rotate(reason) {
  lastFailureAt = Date.now();
  if (keys.length > 1) cursor = (cursor + 1) % keys.length;
  if (process.env.VAULT_DEBUG) console.log(`[tmdb] rotate → key #${cursor} (${reason})`);
}

async function tmdbGet(path, params = '') {
  if (!keys.length) return null;
  await backoffIfHot();
  const key = keys[cursor];
  const url = `${BASE}${path}?api_key=${key}${params}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (res.status === 401 || res.status === 429 || res.status === 404) {
      rotate(`HTTP ${res.status}`);
      // one retry on the next key
      if (keys.length > 1) {
        const retry = await fetch(`${BASE}${path}?api_key=${keys[cursor]}${params}`, { signal: AbortSignal.timeout(9000) });
        if (!retry.ok) return null;
        return retry.json();
      }
      return null;
    }
    if (!res.ok) return null;
    return res.json();
  } catch {
    rotate('network');
    return null;
  }
}

/** Loose title key: case, punctuation, accents and "&"/"and" differences ignored. */
export const normalizeTitle = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/**
 * Pick the best candidate for { title, year }, or null.
 *
 * Rules, in order:
 *   1. the candidate's title (or original title) must match ours — exactly for
 *      short titles ("4" must not match "4 Kings"), by containment for longer
 *      ones ("Veyil" ≈ "Veyil 2024 Special")
 *   2. when both years are known they must be within ±1 (a same-named film from
 *      another decade is a different film)
 *   3. an exact title + exact year beats everything
 */
export function pickBestMatch(results = [], { title, year } = {}) {
  const want = normalizeTitle(title);
  if (!want) return null;
  const wantYear = Number(year) || 0;
  let best = null;
  for (const hit of results || []) {
    const names = [hit.title, hit.original_title, hit.name].map(normalizeTitle).filter(Boolean);
    let score = 0;
    for (const name of names) {
      if (name === want) score = Math.max(score, 3);
      else if (want.length > 3 && name.length > 3 && (name.includes(want) || want.includes(name))) score = Math.max(score, 2);
    }
    if (!score) continue;
    const hitYear = Number(String(hit.release_date || hit.first_air_date || '').slice(0, 4)) || 0;
    if (wantYear && hitYear) {
      if (Math.abs(hitYear - wantYear) > 1) continue; // wrong film, same name
      if (hitYear === wantYear) score += 2;
    }
    if (!best || score > best.score) best = { hit, score };
  }
  return best?.hit || null;
}

const toMeta = (source = {}) => ({
  tmdbId: source.id || source.tmdbId || 0,
  imdbId: source.external_ids?.imdb_id || source.imdb_id || '',
  poster: source.poster_path ? `${REDIRECT_HINT}${source.poster_path}` : '',
  rating: Number(source.vote_average) || 0,
  year: Number(String(source.release_date || '').slice(0, 4)) || 0,
});

/**
 * Enrich one record from its title: { title, year } → metadata.
 * Costs 2 requests (search + details); the details call is what guarantees the
 * poster belongs to the id we actually matched.
 */
export async function enrichWithTmdb({ title, year }) {
  const empty = { tmdbId: 0, imdbId: '', poster: '', rating: 0, year: year || 0 };
  if (!keys.length || !title) return empty;

  const search = await tmdbGet('/search/movie', `&query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`);
  const hit = pickBestMatch(search?.results, { title, year });
  if (!hit) return empty;

  const details = (await tmdbGet(`/movie/${hit.id}`, '&append_to_response=external_ids')) || hit;
  return { ...empty, ...toMeta(details), tmdbId: hit.id };
}

/**
 * Metadata for a KNOWN tmdb id — no search, no ambiguity. Used to repair records
 * that matched earlier but came back without a poster.
 */
export async function movieDetails(id) {
  if (!keys.length || !id) return null;
  const details = await tmdbGet(`/movie/${id}`, '&append_to_response=external_ids');
  if (!details?.id) return null;
  return toMeta(details);
}
