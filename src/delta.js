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
import { listAllSections, listSeries } from './sections.js';
import { retryStatus, partialStatus, RETRY_HOURS } from './schedule.js';

/**
 * The retry ladder lives in src/schedule.js (shared with the writer side).
 * Re-exported here because this is where consumers have always imported it.
 */
export { retryStatus };
export const RETRY_DAYS = [1, 3, 7, 30]; // legacy day-ladder, still exported
export { RETRY_HOURS };

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
    if (!Array.isArray(parsed.skipPaths) || !parsed.skipPaths.every(p => typeof p === 'string' && p.startsWith('/'))) throw new Error('skipPaths must be an array of absolute paths');
    return parsed.skipPaths.map(pathOf);
  } catch (error) { throw new Error(`Cannot load required aliases: ${error.message}`); }
}

/** The hand-maintained alias config: config/page-aliases.json. */
export const PAGE_ALIAS_FILE = new URL('../config/page-aliases.json', import.meta.url);
export function loadPageAliases(file = PAGE_ALIAS_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed.mergeInto || Array.isArray(parsed.mergeInto) || typeof parsed.mergeInto !== 'object') throw new Error('mergeInto must be a path-to-ID object');
    if (!Array.isArray(parsed.skipPaths) || !parsed.skipPaths.every(p => typeof p === 'string' && p.startsWith('/'))) throw new Error('Invalid skipPaths');
    if (!Number.isFinite(Number(parsed.refreshHours ?? 24)) || Number(parsed.refreshHours ?? 24) < 1 || Number(parsed.refreshHours ?? 24) > 720) throw new Error('refreshHours must be 1..720');
    if (parsed.origin && !['https://moviesda34.com', 'https://moviezda.net'].includes(parsed.origin)) throw new Error('Invalid alias origin');
    for (const [p, id] of Object.entries(parsed.mergeInto)) if (!p.startsWith('/') || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error('Invalid alias path/ID');
    const mergeInto = {};
    for (const [path, id] of Object.entries(parsed.mergeInto || {})) mergeInto[pathOf(path)] = id;
    return {
      mergeInto,
      skipPaths: Array.isArray(parsed.skipPaths) ? parsed.skipPaths.map(pathOf) : [],
      families: parsed.families || {},
      refreshHours: Number(parsed.refreshHours ?? 24),
      origin: parsed.origin || 'https://moviesda34.com',
    };
  } catch (error) {
    throw new Error(`Cannot load required page aliases: ${error.message}`);
  }
}

/** Pages that describe an existing record: known, never ingested as new. */
export const aliasPaths = (pageAliases = {}) => Object.keys(pageAliases.mergeInto || {});

/** Every path already attempted (state), stored (vault), or deliberately skipped. */
/**
 * Alias pages that describe a record we already store, and are due another walk.
 *
 * The site re-lists a running series on a fresh URL every so often and lets the
 * old page rot into a navigation stub. The new page is the only place new
 * episodes appear, so walking it is what keeps the record current — but it must
 * merge into the EXISTING record (never mint a second one). Entries come out
 * `locked` with the target's id/title/year, so the walk re-walks the page and
 * upserts straight into the record.
 *
 * Cadence: pageAliases.refreshHours (default 24). A page that comes back empty
 * falls through the ordinary retry ladder via its own state entry.
 */
export function aliasQueueEntries({ state = {}, vault = [], pageAliases = {}, now = Date.now() } = {}) {
  const origin = pageAliases.origin || 'https://moviesda34.com';
  const hours = Number(pageAliases.refreshHours ?? 24) || 0;
  const rows = [];
  for (const [path, targetId] of Object.entries(pageAliases.mergeInto || {})) {
    const record = vault.find((m) => m.id === targetId);
    if (!record) continue; // alias for something we do not store (yet)
    const url = `${origin}${path}`;
    const last = Date.parse(state.done?.[url]?.at || '') || 0;
    if (hours && last && now - last < hours * 3_600_000) continue;
    rows.push({
      url,
      path,
      label: '',
      title: record.title,
      year: record.year,
      kind: record.kind === 'series' ? 'series' : 'movie',
      id: record.id,
      locked: true,
      source: 'alias',
    });
  }
  return rows;
}

export function knownPaths({ state = {}, vault = [], aliases = [], pageAliases = {} } = {}) {
  const known = new Set();
  for (const url of Object.keys(state.done || {})) known.add(pathOf(url));
  for (const record of vault) if (record?.pageUrl) known.add(pathOf(record.pageUrl));
  for (const path of [...aliases, ...(pageAliases.skipPaths || [])]) known.add(pathOf(path));
  for (const path of aliasPaths(pageAliases)) known.add(pathOf(path));
  return known;
}

/**
 * Items whose retry window has opened — the counterexample to "already done".
 *
 * v2.1: `dead` entries (a page that failed to load MAX_FAILURES times in a row)
 * are skipped for good, and the queue is ordered by when each item became due —
 * the run should spend its budget on the items that have waited longest, not on
 * whatever happened to be first in the iteration order.
 */
export function dueForRetry({ state = {}, vault = [], aliases = [] } = {}, now = Date.now()) {
  const stored = new Set(vault.map((r) => pathOf(r.pageUrl)));
  const out = [];
  for (const [url, entry] of Object.entries(state.done || {})) {
    const path = pathOf(url);
    const existing = vault.find(r => pathOf(r.pageUrl) === path);
    if (stored.has(path) && !entry.failures && !entry.empty) continue;
    if (aliases.includes(path)) continue; // known alternate URL, never ingest
    const status = retryStatus(entry, now);
    if (!status.due || status.dead) continue;
    out.push({
      path,
      url: path.startsWith('http') ? path : `https://moviesda34.com${path}`,
      label: '',
      kind: /-web-series\/$|-tamil-season-\d+\/?$/.test(path) ? 'series' : 'movie',
      source: `retry:${status.attempt + 1}`,
      ...(existing ? { id: existing.id, title: existing.title, year: existing.year, kind: existing.kind || 'movie', locked: true } : {}),
      attempt: status.attempt,
      dueAt: entry.retryAfter || entry.at || '',
    });
  }
  out.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  return out;
}

/**
 * Items that WERE stored but only partially walked (some hop failed).
 *
 * These are the "16-embed film that came back with 6 embeds because one folder
 * page 502'd" case. They are re-walked once, 24h later, and merged — the union
 * merge means a re-walk can only ever add links, never drop them.
 *
 * The entry is `locked`: its id/title/year come from the stored record, so a
 * re-walk can never mint a second record for a film the vault already has
 * (the discovery label is not trusted for these).
 */
export function partialRechecks({ state = {}, vault = [], aliases = [] } = {}, now = Date.now()) {
  const byPath = new Map(vault.map((r) => [pathOf(r.pageUrl), r]));
  const out = [];
  for (const [url, entry] of Object.entries(state.done || {})) {
    const path = pathOf(url);
    if (!entry?.partial || aliases.includes(path)) continue;
    const status = partialStatus(entry, now);
    if (!status.due) continue;
    const record = byPath.get(path);
    if (!record) continue; // stored record gone → the normal retry path owns it
    out.push({
      path,
      url: path.startsWith('http') ? path : `https://moviesda34.com${path}`,
      label: '',
      kind: record.kind === 'series' ? 'series' : 'movie',
      id: record.id,
      title: record.title,
      year: record.year || 0,
      locked: true,
      source: `recheck:${status.rechecks + 1}`,
      dueAt: entry.at || '',
    });
  }
  out.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  return out;
}

/**
 * Is this discovery good enough to be believed?
 *
 * If both feeds fail, "nothing new today" is not information — it is a broken
 * run, and the CLI must not record its items as walked-and-empty. The same
 * reasoning applies to a sweep that returns a tiny section: the site changed
 * shape, not the catalogue.
 */
export function assessDiscovery({ mode = 'incremental', sources = {}, fresh = 0 } = {}) {
  const asCount = (v) => (typeof v === 'number' ? v : -1); // "error: …" → unusable
  const problems = [];
  if (mode === 'incremental') {
    const sitemap = asCount(sources.sitemap);
    const latest = asCount(sources['latest-updates']);
    const series = asCount(sources['web-series']);
    if (sitemap < 0 && latest < 0 && series < 0) problems.push('every discovery feed failed');
    else if (sitemap < 0) problems.push('sitemap feed failed (latest-updates + web-series only)');
    else if (sitemap > 0 && sitemap < 20) problems.push(`sitemap yielded only ${sitemap} urls (site shape change?)`);
  }
  if (mode === 'sweep') {
    const listings = asCount(sources.listings);
    if (asCount(sources.sections) <= 0) problems.push('sweep listings returned nothing');
  }
  return { degraded: problems.length > 0, problems, fresh };
}

/**
 * Discovery modes.
 *   incremental — sitemap + latest-updates (2 requests) plus due retries
 *   sweep       — every listing in the registry (~1,000+ pages, the safety net)
 * Both then diff against what is already known.
 */
export async function discover({ mode = 'incremental', walk, state, vault, aliases = [], pageAliases = {}, maxPages = 0, since = 0, onProgress = null } = {}) {
  const known = knownPaths({ state, vault, aliases, pageAliases });
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
    // The sitemap carries ZERO web-series URLs (verified 2026-10-01), and the
    // latest-updates rail's labels are all "Download Now". Without this one
    // listing page, a brand-new series is invisible to the nightly run.
    try { absorb(await listSeries({ walk, maxPages: 2 }), 'web-series'); }
    catch (error) { sources['web-series'] = `error: ${error.message}`; }
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
  const retries = dueForRetry({ state, vault, aliases }).filter((row) => !found.has(row.path));
  const rechecks = partialRechecks({ state, vault, aliases }).filter((row) => !found.has(row.path));
  const health = assessDiscovery({ mode, sources, fresh: fresh.length });

  return {
    known: known.size,
    skippedAliases: aliases.length,
    fresh,
    retries,
    rechecks,
    health,
    // new arrivals first (they are the point), then due retries oldest-first,
    // then the small set of partially-walked items worth a second pass
    queue: [...fresh, ...retries, ...rechecks],
    sources,
  };
}
