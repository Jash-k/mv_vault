/**
 * src/posters.js — the site's OWN posters, as a second source.
 *
 * Why this exists: posters used to come from TMDB alone, and only at the moment
 * a record was added. Two things then go wrong:
 *
 *   1. A brand-new release is often on moviesda before TMDB has an entry for it
 *      (or TMDB has the entry with no poster yet — very common for Tamil
 *      releases in their first days). The record was stored poster-less and
 *      NOTHING ever looked again.
 *   2. TMDB's poster is `null` for a lot of older regional films. Those records
 *      stay blank forever, even though the site itself shows a poster.
 *
 * The item page carries its own poster:
 *
 *   <img src="/uploads/posters/romanchakam-2026.jpg" alt="… Tamil Movie Poster">
 *
 * and the filename is the page path minus its type suffix — so the URL is
 * DERIVABLE without any API key:
 *
 *   /romanchakam-2026-tamil-movie/     → /uploads/posters/romanchakam-2026.jpg
 *   /bigg-boss-2026-tamil-web-series/  → /uploads/posters/bigg-boss-2026.jpg
 *
 * Verified shape (2026-10-01): present → HTTP 200, image/jpeg, ~40 KB.
 * absent → HTTP 302 to /movies.php with an empty body (the site's soft 404).
 *
 * The safety rule is the same as the embed sweep: a network failure is UNKNOWN
 * and writes nothing. Only an answer from the server may change a record.
 */
import { slugify, requestSignal, fetchBounded, readBody } from './http.js';

const POSTER_HOST = (process.env.VAULT_POSTER_HOST || 'https://moviezda.net').replace(/\/$/, '');
const TYPE_SUFFIX = /-(?:tamil-)?web-series$|-tamil-season-\d+$|-tamil-dubbed-movie$|-(?:tamil-)?movie-moviesda$|-(?:tamil-)?moviesda$|-tamil-movie$|-movie$/;
/** A 1×1 placeholder or an error page is not a poster. */
export const MIN_POSTER_BYTES = Number(process.env.VAULT_POSTER_BYTES || 1000);

/** The poster filename for a page path: the path slug minus its type suffix. */
export const posterSlug = (path = '') => String(path || '').replace(/^\/|\/$/g, '').replace(TYPE_SUFFIX, '');

/**
 * Slug guesses for a record, best first.
 *
 * Measured against the 360 site posters already stored in the vault: the page
 * slug minus its type suffix reproduces 98% of the filenames on its own. The
 * rest are pages whose path and poster filename diverged (the site published
 * `/x-moviesda/` but named the poster after the title and year), so the raw
 * slug, the record id and `slugify(title)-year` are tried in turn. Each miss is
 * one small request; a hit ends the search.
 */
export function posterCandidates(record = {}) {
  const out = [];
  try {
    const path = new URL(record.pageUrl).pathname;
    out.push(posterSlug(path), path.replace(/^\/|\/$/g, ''));
  } catch { /* no usable pageUrl */ }
  if (record.id) out.push(record.id);
  const byTitle = `${slugify(record.title || '')}${record.year ? `-${record.year}` : ''}`;
  if (byTitle) out.push(byTitle);
  return [...new Set(out.filter(Boolean))];
}

/** The poster URLs to try for a record, in order. */
export const posterUrls = (record) =>
  posterCandidates(record).map((slug) => `${POSTER_HOST}/uploads/posters/${slug}.jpg`);

/**
 * Pull the poster out of an item page's HTML, if it has one.
 * Accepts the poster <img> and an og:image that points at /uploads/posters/.
 * Returns an absolute URL on POSTER_HOST, or '' when the page shows none.
 */
export function posterFromHtml(html = '', base = '') {
  const text = String(html);
  // 1. the poster <img> the page renders ("… - Tamil Movie Poster")
  const img = text.match(/<img[^>]+src=["']([^"']*\/uploads\/posters\/[^"']+)["']/i)?.[1];
  if (img) return new URL(new URL(img, POSTER_HOST).pathname, POSTER_HOST).href;
  // 2. an og:image pointing at the poster folder
  const og = text.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i)?.[1];
  if (og) {
    const path = og.match(/\/uploads\/posters\/([^"'\s)]+)/i)?.[1];
    if (path) return `${POSTER_HOST}/uploads/posters/${path}`;
    try { return new URL(og, base || undefined).href; } catch { /* fall through */ }
  }
  // 3. any other mention of a poster file (last resort)
  const stray = text.match(/\/uploads\/posters\/([^"'\\\s)]+\.(?:jpe?g|png|webp))/i)?.[1];
  return stray ? `${POSTER_HOST}/uploads/posters/${stray}` : '';
}

/**
 * Is this poster URL real? `state`: 'live' | 'absent' | 'unknown'.
 * `absent` is the site's soft 404 (302) as well as a hard 404/410.
 */
export async function verifyPoster(url, { fetchImpl = fetchBounded, timeoutMs = 15000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      redirect: 'manual', // the site answers "no poster" with a 302 to movies.php
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36', Accept: 'image/*,*/*' },
      signal: requestSignal(timeoutMs),
    });
    const status = res.status;
    // 302 → /movies.php is the site's soft 404; 404/410 are the hard kind
    if (status === 404 || status === 410 || status === 204) return { url, state: 'absent', reason: `HTTP ${status}` };
    if (status >= 300 && status < 400) {
      const location = new URL(res.headers.get('location') || '/', url);
      return { url, state: location.pathname === '/movies.php' ? 'absent' : 'unknown', reason: `HTTP ${status} redirect` };
    }
    // a 5xx is a broken server, NOT "this film has no poster" — never write on it
    if (!res.ok) return { url, state: 'unknown', reason: `HTTP ${status}` };
    const type = res.headers.get('content-type') || '';
    const bytes = res.body ? (await readBody(res, 5 * 1024 * 1024)).byteLength : 0;
    if (!type.startsWith('image/')) return { url, state: 'absent', reason: `not an image (${type || 'no type'})` };
    if (bytes < MIN_POSTER_BYTES) return { url, state: 'absent', reason: `too small (${bytes} bytes)` };
    return { url, state: 'live', bytes, type };
  } catch (error) {
    return { url, state: 'unknown', reason: error.message }; // never write on a failed request
  }
}

/**
 * Fill in missing posters from the site, one request per candidate.
 *
 * Never overwrites a poster a record already has, and never writes on an
 * `unknown` verdict, so a flaky connection cannot blank the catalogue.
 *
 * @returns { checked, filled, absent, unknown }
 */
export async function backfillPosters(vault, { limit = 0, concurrency = 8, onProgress = null, fetchImpl = fetchBounded } = {}) {
  const stats = { checked: 0, filled: 0, absent: 0, unknown: 0 };
  const targets = vault.filter((m) => !m.poster && (m.pageUrl || m.id));
  const work = limit ? targets.slice(0, limit) : targets;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, work.length)) }, async () => {
    while (cursor < work.length) {
      if (Number(process.env.VAULT_DEADLINE_MS || Infinity) <= Date.now()) break;
      const record = work[cursor++];
      for (const url of posterUrls(record)) {
        const verdict = await verifyPoster(url, { fetchImpl });
        stats.checked += 1;
        if (verdict.state === 'live') {
          record.poster = verdict.url;
          stats.filled += 1;
          onProgress?.(record, verdict);
          break;
        }
        if (verdict.state === 'unknown') {
          stats.unknown += 1;
          onProgress?.(record, verdict);
          break; // the host is not answering — stop poking it
        }
        stats.absent += 1;
        onProgress?.(record, verdict);
      }
    }
  }));
  return stats;
}
