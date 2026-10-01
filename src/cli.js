#!/usr/bin/env node
/**
 * moviesda-vault CLI v2.1 — discovery + fast walk + FAILURE-AWARE bookkeeping.
 *
 * Modes
 *   --letters=a-c            historic A–Z letter walk      (fast walker)
 *   --incremental            NEW ARRIVALS: sitemap.xml + /tamil-latest-updates/
 *                            + due retries + partial re-walks      (2 requests)
 *   --sweep                  every listing the site publishes (the safety net)
 *   --item=<url>             re-walk one item
 *   --queue=<file>           walk an explicit JSON queue (see data/incoming.json)
 *
 * Flags
 *   --max-pages=N            cap listing pages per section  (0 = all)
 *   --max-movies=N           cap items this run             (default 250)
 *   --budget-min=N           soft stop before the CI job cap (default 330)
 *   --concurrency=N          items walked in parallel       (default 6)
 *   --kind=movie,series      restrict what gets walked
 *   --dry                    discover + walk, write nothing
 *   --strict                 exit non-zero when the run is degraded
 *
 * Env: TMDB_KEYS=k1,k2,k3 · VAULT_BUDGET_MIN · VAULT_MAX_MOVIES · VAULT_STRICT=1
 *
 * v2.1 — what changed and why (the "never miss a new release" contract):
 *
 *   1. A FAILED READ IS NOT AN EMPTY PAGE. `walkItem` now throws when the item
 *      page itself could not be read, and reports `partial` when some hop of a
 *      walk failed. Before, either case returned `{embeds: []}`, which the CLI
 *      recorded with `markEmpty()` — advancing the 12h→1d→3d→7d→30d ladder. So
 *      a single 502 on a brand-new film deferred it for a day, then a week.
 *      Now: failure → retry in 90 minutes; partial → merged + re-walk in 24h.
 *   2. EMPTIES ARE A DEFERRED VERDICT. Results are buffered and only written as
 *      "empty" once the run is known to be healthy (see `walkHealth()`). If 85%
 *      of the walk came back empty, the site changed shape — writing 250 empty
 *      verdicts would poison the ladder for the whole catalogue.
 *   3. THE RUN REPORTS ITS OWN HEALTH to data/last-run.json, which the watchdog
 *      and the workflow read. "Nothing new today" and "I failed to look" are
 *      different facts and are now distinguishable.
 */
import { listLetter } from './scraper.js';
import { createWalk, walkItem } from './walk.js';
import { discover, loadAliases, loadPageAliases, aliasQueueEntries } from './delta.js';
import { isRejected, titleForEntry } from './titles.js';
import { enrichWithTmdb, keyCount } from './tmdb.js';
import {
  loadData, saveAll, saveRun, upsertRecord, recordFromWalk, recordKind,
  markDone, markEmpty, markFailed, markPartial,
  loadLiveness, saveLiveness,
} from './store.js';
import { httpStats } from './http.js';
import { runMaintenance } from './refresh.js';
import { assessWalk, combineHealth, decideNoEmbeds } from './health.js';
import { parseTitleYear, slugify } from './http.js';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const LETTERS = String(arg('letters', 'a-z') || 'a-z').replace(/\s/g, '');
const MAX_PAGES = Number(arg('max-pages', process.env.VAULT_MAX_PAGES || 0)) || 0;
const MAX_MOVIES = Number(arg('max-movies', process.env.VAULT_MAX_MOVIES || 250)) || 250;
const BUDGET_MS = (Number(arg('budget-min', process.env.VAULT_BUDGET_MIN || 330)) || 330) * 60 * 1000;
const CONCURRENCY = Number(arg('concurrency', 6)) || 6;
const SINGLE_ITEM = arg('item', '');
const QUEUE_FILE = arg('queue', '');
const KINDS = String(arg('kind', 'movie,series')).split(',').map((k) => k.trim()).filter(Boolean);
const DRY = has('dry');
const STRICT = has('strict') || process.env.VAULT_STRICT === '1';
const CHECKPOINT_EVERY = Number(arg('checkpoint', 25)) || 25;
/**
 * Rolling liveness maintenance, run at the end of every incremental run:
 * verify this many records' embeds (least-recently-checked first) and re-walk
 * up to REFRESH_N of the ones that lost a link. Set either to 0 to disable.
 */
const LIVENESS_N = Number(arg('liveness', process.env.VAULT_LIVENESS_N ?? 600)) || 0;
const REFRESH_N = Number(arg('refresh-limit', process.env.VAULT_REFRESH_N ?? 40)) || 0;
/** `--refresh=N` — a standalone maintenance run over the whole catalogue. */
const REFRESH_ONLY = has('refresh') || arg('refresh', '') !== '';
/** Alternate URLs for titles already stored — never ingested (see data/aliases.json). */
const ALIASES = loadAliases(new URL('../data/aliases.json', import.meta.url));
/** config/page-aliases.json — pages that describe a record we already have. */
const PAGE_ALIASES = loadPageAliases();

const MODE = REFRESH_ONLY ? 'refresh'
  : SINGLE_ITEM ? 'item'
  : QUEUE_FILE ? 'queue'
    : has('incremental') ? 'incremental'
      : has('sweep') ? 'sweep'
        : 'letters';

/** `a-c` → ['a','b','c']; `a,d,h` → ['a','d','h'] */
function expandLetters(value) {
  if (!value.includes('-')) return value.split(',').filter(Boolean);
  const [from, to] = value.split('-');
  const out = [];
  for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code += 1) out.push(String.fromCharCode(code));
  return out;
}

const pathOf = (value) => {
  try { return new URL(value).pathname; } catch { return String(value || ''); }
};

const started = Date.now();
const deadline = started + BUDGET_MS;

console.log(`[vault] mode=${MODE} concurrency=${CONCURRENCY} maxMovies=${MAX_MOVIES} budget=${Math.round(BUDGET_MS / 60000)}min${DRY ? ' DRY RUN' : ''}${STRICT ? ' STRICT' : ''}`);
console.log(`[vault] tmdb keys loaded: ${keyCount()}`);

const { state, vault } = loadData();
const walk = createWalk({ concurrency: CONCURRENCY });

const counts = { added: 0, merged: 0, unchanged: 0, empty: 0, failed: 0, skipped: 0, embeds: 0, series: 0, partial: 0 };

/**
 * Items that came back with no embeds. NOT written yet: "empty" is a claim
 * about the site, and it may only be recorded once we believe the run.
 */
const pendingEmpty = [];
const failures = [];
let discoveryHealth = { degraded: false, problems: [] };
let runIntegrity = true;
let sinceCheckpoint = 0;

function checkpoint(force = false) {
  if (DRY) return;
  if (!force && sinceCheckpoint < CHECKPOINT_EVERY) return;
  saveAll({ state, vault });
  sinceCheckpoint = 0;
}

/** Title + year for a discovered item — see titles.js:titleForEntry(). */
const titleFor = (entry) => titleForEntry(entry);

/** Turn a discovered row into a walkable queue entry, or reject it. */
function toQueueEntry(entry) {
  if (ALIASES.includes(entry.path)) { counts.skipped += 1; return null; } // alias of a stored title
  // A re-walk of a STORED record keeps the record's identity (id/title/year):
  // the discovery label must never mint a second record for a film we have.
  if (entry.locked && entry.id) {
    if (!KINDS.includes(entry.kind)) { counts.skipped += 1; return null; }
    return { ...entry, path: entry.path || pathOf(entry.url) };
  }
  const { title, year } = titleFor(entry);
  const reject = isRejected(entry.label || title, entry.path, { title, year });
  if (reject) { counts.skipped += 1; return null; }
  if (!KINDS.includes(entry.kind)) { counts.skipped += 1; return null; }
  const id = `${slugify(title)}${year ? `-${year}` : ''}`;
  if (!id) { counts.skipped += 1; return null; }
  return { ...entry, title, year, id };
}

async function buildQueue() {
  const queue = [];
  const push = (entry) => { const row = toQueueEntry(entry); if (row) queue.push(row); };

  if (MODE === 'refresh') return queue; // nothing to discover: see the maintenance pass

  if (MODE === 'item') {
    const path = pathOf(SINGLE_ITEM);
    push({ url: SINGLE_ITEM, path, label: '', kind: /web-series|-tamil-season-\d+/.test(path) ? 'series' : 'movie', source: 'item' });
    return queue;
  }

  if (MODE === 'queue') {
    const { readFile } = await import('node:fs/promises');
    const rows = JSON.parse(await readFile(QUEUE_FILE, 'utf8'));
    for (const row of rows) push({ ...row, path: row.path || pathOf(row.url), source: 'queue' });
    return queue;
  }

  if (MODE === 'letters') {
    for (const letter of expandLetters(LETTERS)) {
      console.log(`[vault] letter ${letter.toUpperCase()}`);
      state.letters[letter] = { startedAt: state.letters[letter]?.startedAt || new Date().toISOString() };
      const items = await listLetter(letter, {
        maxPages: MAX_PAGES,
        onPage: (l, p, count, total) => console.log(`  page ${p}: ${count} items (total ${total})`),
      });
      for (const item of items) {
        if (state.done[item.url]) continue; // resumable: never re-walk a known URL
        push({ url: item.url, path: pathOf(item.url), label: item.label, kind: 'movie', source: `letter:${letter}` });
      }
      state.letters[letter].finishedAt = new Date().toISOString();
    }
    return queue;
  }

  // incremental / sweep — discovery through the delta layer
  const result = await discover({
    mode: MODE === 'sweep' ? 'sweep' : 'incremental',
    walk,
    state,
    vault,
    aliases: ALIASES,
    pageAliases: PAGE_ALIASES,
    maxPages: MAX_PAGES,
    onProgress: MODE === 'sweep'
      ? (target, count, total) => console.log(
        `  ${target.section.label} ${target.key}: ${count} items${target.section.index ? ' (index page — 0 expected)' : ''} (running total ${total})`)
      : null,
  });

  discoveryHealth = result.health || discoveryHealth;
  console.log(`[vault] known paths=${result.known}  sources=${JSON.stringify(result.sources)}`);
  if (result.skippedAliases) console.log(`[vault] alias URLs excluded=${result.skippedAliases} (data/aliases.json)`);
  console.log(`[vault] new arrivals=${result.fresh.length}  due-retries=${result.retries.length}  partial-rechecks=${result.rechecks.length}`);
  if (discoveryHealth.degraded) {
    console.warn(`[vault] DISCOVERY DEGRADED — ${discoveryHealth.problems.join('; ')}. Treating "0 new arrivals" as unknown, not as fact.`);
  }
  for (const entry of result.queue) push(entry);

  // Re-listed pages (config/page-aliases.json): walked on their own cadence and
  // merged into the record they belong to, so a series that moved to a new URL
  // keeps gaining episodes instead of going quietly stale.
  const aliasRows = aliasQueueEntries({ state, vault, pageAliases: PAGE_ALIASES });
  for (const row of aliasRows) push(row);
  if (aliasRows.length) console.log(`[vault] alias pages due=${aliasRows.length}: ${aliasRows.map((r) => `${r.path} → ${r.id}`).join(', ')}`);
  return queue;
}

/** How believable is this run's "the site has nothing here" verdict? (src/health.js) */
const walkHealth = () => assessWalk(counts, { unreadableUrls: walk.failures?.size || 0 });
const runHealth = () => combineHealth(discoveryHealth, walkHealth());

/**
 * Write the buffered "no embeds" verdicts.
 *
 * Healthy run  → markEmpty: the ladder advances (12h/1d/3d/7d/30d), because a
 *                live page with no embed yet is exactly the new-release case.
 * Degraded run → markFailed: the ladder does NOT advance; the item is looked at
 *                again in 90 minutes instead of being written off for a day.
 */
function flushEmpties() {
  if (!pendingEmpty.length) return;
  if (DRY) { pendingEmpty.length = 0; return; }
  const decision = decideNoEmbeds(runHealth());
  if (decision.verdict === 'failed') {
    runIntegrity = false;
    console.warn(`[vault] ${pendingEmpty.length} item(s) returned no embeds, but this run is DEGRADED (${decision.reason}).`);
    console.warn('[vault] recording them as FAILED (re-try in 90 min) instead of empty (12h→30d ladder) — the walk result is not trustworthy.');
    for (const { entry, kind } of pendingEmpty) markFailed(state, entry.url, { kind, error: `no embeds during a degraded run: ${decision.reason}` });
  } else {
    for (const { entry, kind } of pendingEmpty) markEmpty(state, entry.url, { kind });
  }
  pendingEmpty.length = 0;
}

/** Walk one item and merge it into the vault, recording what actually happened. */
async function processEntry(entry) {
  let walked;
  try {
    walked = await walkItem(entry.url, { walk });
  } catch (error) {
    // Unreadable item page: nothing was learned. NEVER an "empty" verdict.
    counts.failed += 1;
    failures.push(`${entry.url} — ${error.message}`);
    console.warn(`  ! ${entry.title || entry.path}: ${error.message} (re-try in 90 min)`);
    if (!DRY) markFailed(state, entry.url, { kind: entry.kind, error: error.message });
    sinceCheckpoint += 1;
    checkpoint();
    return;
  }

  const record = recordFromWalk(entry, walked, { id: entry.id });
  const kind = recordKind(record || { kind: entry.kind, seasons: walked.seasons });

  if (!record) {
    // No embeds AND a hop was unreadable → we did not learn that the page is
    // empty, only that we failed to read part of the chain. That is a FAILURE
    // (re-try in 90 min), never an "empty page" (12h→30d ladder). This is the
    // exact case that used to defer a brand-new release by a week.
    if (walked.partial) {
      counts.failed += 1;
      failures.push(`${entry.url} — 0 embeds and ${walked.failures} unreadable hop(s)`);
      console.warn(`  ! ${entry.title || entry.path}: 0 embeds with ${walked.failures} unreadable hop(s) — re-try in 90 min, NOT marking empty`);
      if (!DRY) markFailed(state, entry.url, { kind, error: `${walked.failures} unreadable hop(s)` });
      sinceCheckpoint += 1;
      checkpoint();
      return;
    }
    counts.empty += 1;
    pendingEmpty.push({ entry, kind }); // verdict deferred until the run proves healthy
    console.log(`  – ${entry.title || entry.path}  ${kind}: no live embeds`);
    sinceCheckpoint += 1;
    checkpoint();
    return;
  }

  const { action } = upsertRecord(vault, record);
  counts[action] += 1;
  if (action === 'added' && kind === 'series') counts.series += 1;
  if (action !== 'unchanged') counts.embeds += record.embeds.length; // 'unchanged' re-walk adds nothing

  const episodes = (record.seasons || []).reduce((n, s) => n + s.episodes.length, 0);
  const tag = action === 'added' ? '+' : action === 'merged' ? '~' : '=';
  const partial = walked.partial === true;
  console.log(`  ${tag} ${record.title} (${record.year || '—'}) ${kind}: ${record.embeds.length} embeds${episodes ? ` / ${episodes} episodes` : ''}${partial ? `  ⚠ partial (${walked.failures} hop(s) unreadable — re-walk in 24h)` : ''}`);

  if (!DRY) {
    if (partial) {
      counts.partial += 1;
      markPartial(state, entry.url, { kind, embeds: record.embeds.length, failures: walked.failures });
    } else {
      markDone(state, entry.url, { embeds: record.embeds.length, kind });
    }
  }
  sinceCheckpoint += 1;
  checkpoint();
}

const mapLimit = async (rows, limit, fn) => {
  const out = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) { const index = cursor++; out[index] = await fn(rows[index], index); }
  }));
  return out;
};

/** TMDB metadata for the records this run touched. */
async function enrichNew(entries) {
  const touched = new Set(entries.map((entry) => entry.url));
  const fresh = vault.filter((m) => touched.has(m.pageUrl) && !m.tmdbId);
  const pending = vault.filter((m) => m.embeds?.length && !m.tmdbId);
  if (!fresh.length) {
    if (pending.length) console.log(`[vault] ${pending.length} record(s) still need metadata — run: TMDB_KEYS=… node src/enrich.js`);
    return;
  }
  if (!keyCount()) {
    console.log(`[vault] ${fresh.length} new record(s) have no metadata — set TMDB_KEYS or run src/enrich.js later`);
    return;
  }
  console.log(`[vault] enriching ${fresh.length} new record(s) via TMDB`);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, fresh.length) }, async () => {
    while (cursor < fresh.length) {
      const record = fresh[cursor++];
      try {
        const meta = await enrichWithTmdb({ title: record.title, year: record.year });
        if (!meta?.tmdbId) continue;
        record.poster = meta.poster || record.poster || '';
        record.rating = meta.rating || record.rating || 0;
        record.tmdbId = meta.tmdbId;
        record.imdbId = meta.imdbId || record.imdbId || '';
        if (!record.year && meta.year) record.year = meta.year;
      } catch { /* metadata is never fatal */ }
    }
  }));
  console.log(`[vault] metadata: ${fresh.filter((m) => m.tmdbId).length}/${fresh.length} matched`);
}

let stats = null;
let runLength = 0;
try {
  const queue = await buildQueue();

  // Two URLs can describe one film (alternate slugs) — keep the first, by id.
  // When the two paths DIFFER this is worth shouting about: it is what a junk
  // label collision looks like (every rail item titled "Download Now" maps to
  // the same id, so the run would keep one and drop the rest silently).
  const byId = new Map();
  const collisions = [];
  for (const entry of queue) {
    const seen = byId.get(entry.id);
    if (!seen) { byId.set(entry.id, entry); continue; }
    if (seen.path !== entry.path) collisions.push(`${entry.id}: ${seen.path} vs ${entry.path}`);
  }
  const deduped = [...byId.values()];
  if (deduped.length !== queue.length) console.log(`[vault] de-duplicated ${queue.length - deduped.length} duplicate id(s)`);
  if (collisions.length) {
    console.warn(`[vault] WARNING: ${collisions.length} id collision(s) between DIFFERENT paths — likely a label/parse problem, items may be dropped:`);
    for (const line of collisions.slice(0, 5)) console.warn(`          ${line}`);
  }

  const run = MAX_MOVIES ? deduped.slice(0, MAX_MOVIES) : deduped;
  if (run.length < deduped.length) console.log(`[vault] capping this run at ${run.length} of ${deduped.length} items`);
  runLength = run.length;
  console.log(`[vault] walking ${run.length} item(s) …`);

  await mapLimit(run, CONCURRENCY, async (entry) => {
    if (Date.now() > deadline) return;
    try {
      await processEntry(entry);
    } catch (error) {
      counts.failed += 1;
      failures.push(`${entry.url} — ${error.message}`);
      console.warn(`  ! ${entry.title || entry.path}: ${error.message}`);
      if (!DRY) markFailed(state, entry.url, { kind: entry.kind, error: error.message });
    }
  });

  if (Date.now() > deadline) console.log('[vault] budget reached — stopped gracefully (state is checkpointed, re-run resumes)');
  await enrichNew(run);
} finally {
  /**
   * Rolling liveness maintenance. Runs after the walks so it can spend the
   * remaining budget, and before the final save so the pruned/new links are
   * flushed with everything else. A failure here never fails the run.
   */
  let maintenance = null;
  try {
    const leftMin = Math.max(0, (deadline - Date.now()) / 60000);
    // ~2 records/minute across 8 lanes, so a short run sweeps a short slice
    // instead of blowing past its budget and being killed mid-flight.
    const wanted = Math.min(
      MODE === 'refresh' ? (Number(arg('refresh', 0)) || 500) : LIVENESS_N,
      Math.floor(leftMin * 120),
    );
    if (!DRY && wanted && Date.now() < deadline) {
      const liveness = loadLiveness();
      const before = Date.now();
      maintenance = await runMaintenance({
        vault,
        walk,
        liveness,
        pageAliases: PAGE_ALIASES,
        limit: wanted,
        refreshLimit: REFRESH_N,
        deadline,
        onProgress: (record, result) => console.log(
          `  ⟳ ${record.id}: ${result.walked ? 'refreshed' : 'could not re-walk'} (${result.url || result.tried.map((t) => t.error || t.url).join(', ')})`),
      });
      saveLiveness(liveness);
      if (maintenance.records) {
        console.log(`[vault] liveness: ${maintenance.records} record(s) checked · ${maintenance.live} live · ${maintenance.dead} dead · ${maintenance.unknown} unknown · ${maintenance.refreshed} refreshed · ${maintenance.pruned} dead link(s) pruned${maintenance.partial ? ' (slice cut short by the budget)' : ''} (${Math.round((Date.now() - before) / 1000)}s)`);
      }
      for (const stuck of maintenance.stuck.slice(0, 5)) {
        console.warn(`  ! ${stuck.id}: ${stuck.reason} — queued for re-walk`);
        // straight onto the failure ladder (90 min), keyed by the page the record
        // actually came from — the sweep could not fix it, the walker might.
        if (stuck.url) markFailed(state, stuck.url, { kind: stuck.kind || 'movie', error: `dead links: ${stuck.reason}` });
      }
    }
  } catch (error) {
    console.warn(`[vault] liveness maintenance skipped: ${error.message}`);
  }

  // the deferred verdicts are always written, whatever happened above
  flushEmpties();
  checkpoint(true);
  const withEmbeds = vault.filter((m) => m.embeds?.length);
  stats = {
    vaultTotal: withEmbeds.length,
    vaultEmbeds: withEmbeds.reduce((n, m) => n + m.embeds.length, 0),
  };

  const health = runHealth();
  const degraded = health.degraded;
  const report = {
    mode: MODE,
    dry: DRY,
    strict: STRICT,
    degraded,
    problems: [...discoveryHealth.problems, ...health.problems],
    integrity: runIntegrity,
    queued: runLength,
    counts,
    failures: failures.slice(0, 10),
    requests: walk.stats.reqs,
    http: { ...httpStats },
    liveness: maintenance ? {
      checked: maintenance.records, live: maintenance.live, dead: maintenance.dead,
      unknown: maintenance.unknown, refreshed: maintenance.refreshed,
      pruned: maintenance.pruned, stuck: maintenance.stuck.length,
    } : null,
    vaultTotal: stats.vaultTotal,
    vaultEmbeds: stats.vaultEmbeds,
    minutes: Math.round((Date.now() - started) / 60000),
  };

  console.log('[vault] RUN SUMMARY', JSON.stringify({
    mode: MODE,
    added: counts.added,
    merged: counts.merged,
    unchanged: counts.unchanged,
    empty: counts.empty,
    partial: counts.partial,
    failed: counts.failed,
    skipped: counts.skipped,
    newSeries: counts.series,
    embedsAdded: counts.embeds,
    vaultTotal: stats.vaultTotal,
    vaultEmbeds: stats.vaultEmbeds,
    requests: walk.stats.reqs,
    mirrorRescues: httpStats.mirrorRescues,
    hostsParked: httpStats.hostDowns,
    unreadableUrls: walk.failures?.size || 0,
    ...(maintenance ? {
      embedsChecked: maintenance.checked,
      deadLinks: maintenance.dead,
      refreshed: maintenance.refreshed,
      pruned: maintenance.pruned,
      stuck: maintenance.stuck.length,
    } : {}),
    mb: Number((walk.stats.bytes / 1048576).toFixed(2)),
    minutes: report.minutes,
    ...(degraded ? { degraded: true, problems: report.problems } : {}),
    ...(DRY ? { dry: true } : {}),
  }));

  if (!DRY) {
    saveRun(report);
    console.log(`[vault] run report → data/last-run.json  (degraded=${degraded})`);
  }
  if (DRY) console.log('[vault] --dry: nothing written');

  if (degraded && STRICT) {
    console.error('[vault] STRICT: run was degraded — failing the job so it is visible (data is committed and the next run retries).');
    process.exitCode = 2;
  }
}
