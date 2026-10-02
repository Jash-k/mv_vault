import { fetchBounded, requestSignal, retryAfterMs } from './http.js';
const keys = String(process.env.TMDB_KEYS || process.env.TMDB_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let cursor = 0, cooldownUntil = 0;
export const keyCount = () => keys.length;
export const needsMetadata = (record = {}) => !record.tmdbId || !record.poster || (record.kind === 'series' && record.tmdbType !== 'tv');
const normalise = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const typeOf = kind => kind === 'series' || kind === 'tv' ? 'tv' : 'movie';
export function chooseMatch(results, { title, year, kind = 'movie' }) {
  const type = typeOf(kind), wanted = normalise(title);
  const exact = (results || []).filter(r => [r.title, r.original_title, r.name, r.original_name].some(t => normalise(t) === wanted));
  const yearOf = r => Number((type === 'tv' ? r.first_air_date : r.release_date)?.slice(0, 4)) || 0;
  const sameYear = year ? exact.filter(r => yearOf(r) === Number(year)) : exact;
  // Ambiguous remakes or unknown-year collisions need review, not first-result guessing.
  return sameYear.length === 1 ? sameYear[0] : null;
}
async function tmdbGet(path, params = {}) {
  if (!keys.length || Date.now() < cooldownUntil) return null;
  const query = new URLSearchParams({ api_key: keys[cursor], ...params });
  try {
    const res = await fetchBounded(`https://api.themoviedb.org/3${path}?${query}`, { signal: requestSignal(9000) });
    if (res.status === 429) {
      cooldownUntil = Date.now() + Math.max(60000, retryAfterMs({ headers: res.headers }));
      await res.body?.cancel(); return null; // never rotate keys to evade rate limiting
    }
    if (res.status === 401) { cursor = (cursor + 1) % keys.length; await res.body?.cancel(); return null; }
    if (!res.ok) { await res.body?.cancel(); return null; }
    return await res.json();
  } catch { return null; }
}
function metadata(hit, type) {
  return { tmdbId: hit.id, tmdbType: type, imdbId: hit.external_ids?.imdb_id || '',
    poster: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : '',
    rating: Number(hit.vote_average) || 0,
    year: Number((type === 'tv' ? hit.first_air_date : hit.release_date)?.slice(0, 4)) || 0,
    matchedBy: 'exact-title-year' };
}
export async function fetchByTmdbId(id, kind = 'movie') {
  if (!Number(id)) return null;
  const type = typeOf(kind);
  const hit = await tmdbGet(`/${type}/${id}`, { append_to_response: 'external_ids' });
  return hit?.id ? metadata(hit, type) : null;
}
export async function enrichWithTmdb({ title, year, kind = 'movie' }) {
  const type = typeOf(kind);
  const params = { query: title, ...(year ? { [type === 'tv' ? 'first_air_date_year' : 'year']: String(year) } : {}) };
  const result = await tmdbGet(`/search/${type}`, params);
  const hit = chooseMatch(result?.results, { title, year, kind });
  if (!hit) return null;
  return await fetchByTmdbId(hit.id, type);
}
