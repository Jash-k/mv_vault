/**
 * Delta feeds — the cheapest way to notice a brand-new item.
 *
 * `/sitemap.xml` is the single most valuable source in this repo: 558 URLs each
 * carrying `<lastmod>`, ordered newest-first, in ONE request (~110 KB, ~1.4 s).
 * It is published under the new domain (moviezda.net) while item URLs live under
 * the old one (moviesda34.com), which is why everything here is keyed by
 * **path** — comparing hosts reports all 549 sitemap items as "new" (measured).
 *
 * `/tamil-latest-updates/` is the second source: the site's own "new arrivals"
 * strip, which sometimes carries a same-day drop before the sitemap catches up.
 */
import { isItemPath, kindOfPath } from './sections.js';

export const SITEMAP_URL = 'https://moviesda34.com/sitemap.xml';
export const LATEST_URL = 'https://moviesda34.com/tamil-latest-updates/';

const canonical = (path) => `https://moviesda34.com${path}`;

/** `<loc>` + `<lastmod>` pairs, path-normalised, newest first. */
export async function readSitemap({ walk, since = 0 } = {}) {
  const xml = await walk.get(SITEMAP_URL);
  const entries = [];
  for (const match of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g)) {
    let path;
    try { path = new URL(match[1].trim()).pathname; } catch { continue; }
    if (!isItemPath(path)) continue;
    const lastmod = (match[2] || '').trim();
    const at = lastmod ? Date.parse(lastmod) : 0;
    if (since && at && at <= since) continue;
    entries.push({ path, lastmod, at, kind: kindOfPath(path), url: canonical(path), label: '', source: 'sitemap' });
  }
  entries.sort((a, b) => (b.at || 0) - (a.at || 0));
  return entries;
}

/** Item links from the site's own "latest updates" strip (no pagination). */
export async function readLatest({ walk } = {}) {
  const html = await walk.get(LATEST_URL);
  const out = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    let path;
    try { path = new URL(match[1], LATEST_URL).pathname; } catch { continue; }
    if (!isItemPath(path) || seen.has(path)) continue;
    seen.add(path);
    out.push({
      path,
      label: match[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
      kind: kindOfPath(path),
      url: canonical(path),
      lastmod: '',
      at: 0,
      source: 'latest-updates',
    });
  }
  return out;
}
