/**
 * TMDB enrichment with KEY ROTATION.
 * Set TMDB_KEYS (comma-separated) — each movie's lookup uses the next key in
 * the pool; a 401/404/429 or network error rotates to the next key immediately
 * and retries once, so one exhausted key never stalls the vault.
 * All failures degrade gracefully: the movie keeps rawTitle/poster-less data.
 */

const keys = String(process.env.TMDB_KEYS || process.env.TMDB_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

let cursor = 0;
let lastFailureAt = 0;

export function keyCount() {
  return keys.length;
}

/**
 * Which records still want a TMDB pass?
 *
 * A record with a `tmdbId` but no poster is NOT done: TMDB's poster_path was
 * null when it was enriched (routine for a release in its first days), and the
 * old rule (`!tmdbId`) meant those records were never looked at again. Only a
 * record that has BOTH an id and a poster is finished.
 */
export const needsMetadata = (record = {}) => !record.tmdbId || !record.poster;

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
  const url = `https://api.themoviedb.org/3${path}?api_key=${key}${params}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (res.status === 401 || res.status === 429 || res.status === 404) {
      rotate(`HTTP ${res.status}`);
      // one retry on the next key
      if (keys.length > 1) {
        const retry = await fetch(`https://api.themoviedb.org/3${path}?api_key=${keys[cursor]}${params}`, { signal: AbortSignal.timeout(9000) });
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

const EMPTY = (year) => ({ tmdbId: 0, imdbId: '', poster: '', rating: 0, year: year || 0, matchedBy: '' });
const normalise = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Metadata for a record that already has a TMDB id: one call, exact match. */
export async function fetchByTmdbId(tmdbId) {
  if (!keys.length || !Number(tmdbId)) return null;
  const hit = await tmdbGet(`/movie/${tmdbId}`, '');
  if (!hit?.id) return null;
  let imdbId = '';
  try {
    const ext = await tmdbGet(`/movie/${tmdbId}/external_ids`, '');
    imdbId = ext?.imdb_id || '';
  } catch { /* optional */ }
  return {
    tmdbId: hit.id,
    imdbId,
    poster: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : '',
    rating: Number(hit.vote_average) || 0,
    year: hit.release_date ? Number(hit.release_date.slice(0, 4)) || 0 : 0,
    matchedBy: 'id',
  };
}

/**
 * Enrich one movie: { title, year } → { tmdbId, imdbId, poster, rating, year }.
 * Search is year-guarded; the year is corrected from TMDB when the scrape
 * label had none.
 *
 * A year-guarded miss is retried ONCE without the year — but only an exact
 * title (or original-title) match is accepted. The scrape's year comes from the
 * page path and is often wrong or missing, which used to cost the record its
 * metadata entirely; a fuzzy match would instead risk making it WRONG (the id
 * is permanent), so anything less than an exact title is rejected.
 */
export async function enrichWithTmdb({ title, year }) {
  if (!keys.length || !title) return EMPTY(year);
  const search = await tmdbGet('/search/movie', `&query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`);
  let hit = search?.results?.[0];
  let matchedBy = hit ? 'year' : '';
  if (!hit && year) {
    const loose = await tmdbGet('/search/movie', `&query=${encodeURIComponent(title)}`);
    hit = loose?.results?.find((r) => normalise(r.title) === normalise(title) || normalise(r.original_title) === normalise(title));
    matchedBy = hit ? 'title' : '';
  }
  if (!hit) return EMPTY(year);

  let imdbId = '';
  try {
    const ext = await tmdbGet(`/movie/${hit.id}/external_ids`, '');
    imdbId = ext?.imdb_id || '';
  } catch { /* optional */ }

  return {
    tmdbId: hit.id || 0,
    imdbId,
    poster: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : '',
    rating: Number(hit.vote_average) || 0,
    // a title-only match must not rewrite the year: that hit may be a remake
    year: matchedBy === 'title' ? year || 0 : (hit.release_date ? Number(hit.release_date.slice(0, 4)) || year || 0 : year || 0),
    matchedBy,
  };
}
