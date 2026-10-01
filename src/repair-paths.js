/**
 * src/repair-paths.js — pageUrl → path, with the fallbacks a repair needs.
 *
 * Records written by an older run can carry a pageUrl whose host or shape has
 * since changed (moviesda34.com → moviezda.net, "-tamil-web-series" dropped).
 * The repair derives a title from a PATH, so it wants the most usable path for
 * a record rather than a literal URL parse.
 */
export function inferPath(pageUrl = '') {
  try {
    const path = new URL(pageUrl).pathname;
    return path.startsWith('/') ? path : `/${path}`;
  } catch {
    const text = String(pageUrl || '').trim();
    if (!text) return '';
    return text.startsWith('/') ? text : `/${text.replace(/^https?:\/\/[^/]+/, '')}`;
  }
}
