/**
 * Delta detection — "what is on the site that I have not stored yet?"
 *
 * Three rules learned the hard way:
 *
 *  1. Compare by PATH, never by host. The site moved to moviezda.net and the
 *     sitemap is published there; item URLs are still stored under
 *     moviesda34.com. A host-based diff reports every sitemap entry as new.
 *
 *  2. A page that exists is not a page that plays. New releases routinely appear
 *     with their embed links added days later, so `empty: true` must NOT be
 *     terminal — those items are re-attempted on a widening schedule. Without
 *     this, the detector misses exactly the case it exists for.
 *
 *  3. Never let a hop-failure look like a new item. Only genuinely unseen paths
 *     enter the queue; everything else keeps its existing state.
 */
import { readFileSync } from 'node:fs';
import { readSitemap, readLatest } from './feed.js';
import { listAllSections } from './sections.js';

/** Days to wait before re-attempting an item that yielded no embeds. */
export const RETRY_DAYS = [1, 3, 7, 30];
const DAY_MS = 86_400_000;

export const pathOf = (value) => {
  try { return new URL(value).pathname; } catch { return String(value || ''); }
};

/**
 * Alternate URLs for titles already stored (data/aliases.json). They are
 * deliberately never ingested — without this the detector would happily
 * create a second record for a film it already has.
 */
export function loadAliases(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed.skipPaths) ? parsed.skipPaths.map(pathOf) : [];
  } catch { return []; }
}

/** Every path already attempted (state), stored (vault), or deliberately skipped. */
export function knownPaths({ state = {}, vault = [], aliases = [] } = {}) {
  const known = new Set();
  for (const url of Object.keys(state.done || {})) known.add(pathOf(url));
  for (const record of vault) if (record?.pageUrl) known.add(pathOf(record.pageUrl));
  for (const path of aliases) known.add(pathOf(path));
  return known;
}

/**
 * Is an item that previously produced nothing worth trying again?
 * Returns { due:boolean, attempt:number }.
 */
export function retryStatus(entry, now = Date.now()) {
  if (!entry || !entry.empty) return { due: false, attempt: 0 };
  const attempt = Number(entry.retries || 0);
  if (attempt >= RETRY_DAYS.length) return { due: false, attempt }; // exhausted
  const waitMs = RETRY_DAYS[attempt] * DAY_MS;
  const last = Date.parse(entry.at || '') || 0;
  return { due: now - last >= waitMs, attempt };
}

/** Items whose retry window has opened — the counterexample to "already done". */
export function dueForRetry({ state = {}, vault = [], aliases = [] } = {}, now = Date.now()) {
  const stored = new Set(vault.map((r) => pathOf(r.pageUrl)));
  const out = [];
  for (const [url, entry] of Object.entries(state.done || {})) {
    const path = pathOf(url);
    if (stored.has(path)) continue; // it has embeds now; nothing to recover
    if (aliases.includes(path)) continue; // known alternate URL, never ingest
    const status = retryStatus(entry, now);
    if (!status.due) continue;
    out.push({
      path,
      url: path.startsWith('http') ? path : `https://moviesda34.com${path}`,
      label: '',
      kind: /-web-series\/$|-tamil-season-\d+\/?$/.test(path) ? 'series' : 'movie',
      source: `retry:${status.attempt + 1}`,
      attempt: status.attempt,
    });
  }
  return out;
}

/**
 * Discovery modes.
 *   incremental — sitemap + latest-updates (2 requests) plus due retries
 *   sweep       — every listing in the registry (~1,000+ pages, the safety net)
 * Both then diff against what is already known.
 */
export async function discover({ mode = 'incremental', walk, state, vault, aliases = [], maxPages = 0, since = 0, onProgress = null } = {}) {
  const known = knownPaths({ state, vault, aliases });
  const found = new Map();
  const sources = {};

  const absorb = (rows, name) => {
    sources[name] = rows.length;
    for (const row of rows) if (!known.has(row.path) && !found.has(row.path)) found.set(row.path, row);
  };

  if (mode !== 'sweep') {
    try { absorb(await readSitemap({ walk, since }), 'sitemap'); }
    catch (error) { sources.sitemap = `error: ${error.message}`; }
    try { absorb(await readLatest({ walk }), 'latest-updates'); }
    catch (error) { sources['latest-updates'] = `error: ${error.message}`; }
  }

  if (mode === 'sweep') {
    const swept = await listAllSections({
      walk,
      maxPages,
      onSection: onProgress
        ? (target, count, total) => onProgress(target, count, total)
        : null,
    });
    absorb(swept.items, 'sections');
    sources.listings = swept.listings;
  }

  const fresh = [...found.values()];
  const retries = dueForRetry({ state, vault, aliases });
  const retryQueue = retries.filter((row) => !found.has(row.path));

  return {
    known: known.size,
    skippedAliases: aliases.length,
    fresh,
    retries: retryQueue,
    queue: [...fresh, ...retryQueue],
    sources,
  };
}
