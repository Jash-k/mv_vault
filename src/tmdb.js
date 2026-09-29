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

/**
 * Enrich one movie: { title, year } → { tmdbId, imdbId, poster, rating, year }.
 * Search is year-guarded; the year is corrected from TMDB when the scrape
 * label had none.
 */
export async function enrichWithTmdb({ title, year }) {
  if (!keys.length || !title) return { tmdbId: 0, imdbId: '', poster: '', rating: 0, year: year || 0 };
  const query = `&query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`;
  const search = await tmdbGet('/search/movie', query);
  const hit = search?.results?.[0];
  if (!hit) return { tmdbId: 0, imdbId: '', poster: '', rating: 0, year: year || 0 };

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
    year: hit.release_date ? Number(hit.release_date.slice(0, 4)) || year || 0 : year || 0,
  };
}
