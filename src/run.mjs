#!/usr/bin/env node
/**
 * run.mjs — THE run. Two modes, one job each, no stages:
 *
 *   node src/run.mjs --mode=releases     # the Tamil <year> folder(s) — movies AND series
 *   node src/run.mjs --mode=az           # A–Z folder, resumable, goes on to the next letter
 *   node src/run.mjs --mode=dubbed       # isaiDub (isaidub.green) — the Tamil-dubbed catalogue
 *
 * Releases read the current/next-year folders AND the latest web-series pages.
 * Stored current-year series are a safety net when the listing drops an alias.
 * Use --no-series to disable that extra discovery/refresh explicitly.
 *
 * dubbed mode reads isaidub.green. Default = the newest-first page
 * /tamil-dubbed-hollywood-movies/ walked down until it only sees titles we
 * already have (that page is sorted by date added, exactly like
 * /recent-updates/). --deep adds the weekly safety net (collections index + A–Z
 * letter page 1s), --historic does the whole union (A–Z + collections + the
 * page + recent updates) and is resumable: state.json remembers every walk, so
 * simply run it again until it reports nothing new to walk.
 *
 * Discovery → walk → merge → save → commit. The listing page IS the queue: an
 * item that is still on the listing is found again next run, so there is no
 * queue file to get stuck in.
 *
 * Flags:
 *   --budget-min=N     stop cleanly after N minutes (default 25 releases / 300 az)
 *   --max-items=N      stop after N NEW walks
 *   --commit-every=N   commit+push every N walks (default 100, az 200)
 *   --commit           allow git commit/push (the workflows pass this)
 *   --dry              do everything except write data/ or commit
 *   --only=text        only items whose path contains text (manual testing)
 *   --only-empty       A–Z: only re-check items already known empty/failed
 *                      (a one-off backlog sweep; stored items are skipped anyway)
 *   --year=2027        pin the releases flow to one year (skips the current year)
 *   --tmdb-limit=N     max TMDB lookups per run (default 150)
 *   --check-all        releases mode: probe EVERY stored record's links, not just
 *                      the ones on this year's folder (catches re-uploads of the
 *                      old A–Z catalogue; ~2,900 probes, a few minutes)
 *   --no-link-check    releases mode: skip the stored-link health check entirely
 *   --manifest=FILE    dubbed mode: walk exactly the JSON list of paths in FILE
 *                      (used for the historic slices) instead of crawling
 *   --pages=N          dubbed mode: how many pages of the new page to scan
 *                      (default: until 3 pages in a row add nothing new)
 *   --walk-concurrency=N  walk N titles at once (default 1; the historic run
 *                      uses 4 — the site is fast, and every walk is idempotent)
 *   --with-series      releases mode: ALSO read /tamil-web-series-download/
 *                      (latest 3 pages). Off by default — the year folder already
 *                      carries series; only a couple of pre-2026 series live on
 *                      that folder alone.
 *   --verify-ids       enrich mode: when a stored TMDB id turns out to be the wrong
 *                      work (it resolves to a different title), replace it — and
 *                      its poster/rating — with a freshly matched one
 *   --refresh-days=N   also re-walk stored MOVIES older than N days (default 0 =
 *                      never; movies are normally done once they are stored)
 *   --concurrency=N    enrich mode: parallel TMDB lookups (default 4)
 *   --limit=N          enrich mode: max records this run
 *   --stale-days=N     enrich mode: also re-try records last looked at N+ days ago
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { LIVE, DUB, discover, getHtml, parseListing, walkItem, walkDubbed, parseDubLabel, embedCount, probeEmbed, mapLimit, stats, sleep, WALK_VERSION } from './scrape.mjs';
import * as V from './vault.mjs';
import * as tmdb from './tmdb.mjs';
import { enrichRecord } from './metadata-evidence.mjs';

/* ------------------------------------------------------------------- setup */

const args = process.argv.slice(2);
const arg = (key, fallback = null) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? (args.includes(`--${key}`) ? true : fallback);
const mode = arg('mode', 'releases') === 'tmdb' ? 'enrich' : arg('mode', 'releases'); // 'tmdb' kept as an alias
if (!['releases', 'az', 'enrich', 'dubbed'].includes(mode)) { console.error('usage: --mode=releases | --mode=az | --mode=dubbed | --mode=enrich'); process.exit(2); }
const dry = Boolean(arg('dry', false));
const commitEnabled = Boolean(arg('commit', false)) && !dry;
const only = arg('only', '');
const onlyEmpty = Boolean(arg('only-empty', false));
const sweepEmpty = Boolean(arg('sweep-empty', false));
const verbose = Boolean(arg('verbose', false)) || /^(1|true)$/i.test(String(process.env.VERBOSE || ''));
const refreshDays = Number(arg('refresh-days', 0)) || 0;
const verifyIds = Boolean(arg('verify-ids', false));
const withSeries = !args.includes('--no-series') && arg('with-series', 'true') !== 'false';
const checkAll = Boolean(arg('check-all', false));
const historic = Boolean(arg('historic', false));
const deep = Boolean(arg('deep', false));
const manifest = arg('manifest', '');
const pagesArg = Number(arg('pages', 0)) || 0;
const walkConcurrency = Math.max(1, Math.min(Number(arg('walk-concurrency', 1)) || 1, 6));
const noLinkCheck = Boolean(arg('no-link-check', false));
/**
 * Which year folders the releases flow reads.
 *   default        → the current year AND the next one (2026 + 2027 today). The
 *                    next-year folder already exists on the site as a
 *                    placeholder, so pointing at it costs one request and means
 *                    a title added there is picked up immediately — and nothing
 *                    has to be changed at the year rollover.
 *   --year=2027    → only that year (also the way to run one year by hand).
 */
const currentYear = new Date().getUTCFullYear();
const years = arg('year') ? [String(arg('year'))] : [String(currentYear), String(currentYear + 1)];

const CFG = mode === 'releases'
  ? { budgetMin: 25, maxItems: 0, commitEvery: 100, emptyHours: 24, listingPages: 30, seriesPages: 3, seriesRefreshHours: 5, linkCheck: true, linkCheckHours: 1 } // refresh before the next six-hour schedule
  : mode === 'dubbed'
    ? { budgetMin: 25, maxItems: 0, commitEvery: 200, emptyHours: 24, listingPages: 30, seriesPages: 0, seriesRefreshHours: 24, linkCheck: true, linkCheckHours: 1, maxEpisodePages: 10 }
  : mode === 'enrich'
    ? { budgetMin: 20, maxItems: 0, commitEvery: 500, emptyHours: 0, listingPages: 0, seriesPages: 0, seriesRefreshHours: 0 }
    : { budgetMin: 300, maxItems: 0, commitEvery: 200, emptyHours: 168, listingPages: 1, seriesPages: 0, seriesRefreshHours: 168 };

const budgetMin = Number(arg('budget-min', CFG.budgetMin));
const maxItems = Number(arg('max-items', CFG.maxItems)) || 0;
const commitEvery = Number(arg('commit-every', CFG.commitEvery)) || 0;
const tmdbLimit = Number(arg('tmdb-limit', 150));
const started = Date.now();
const deadline = started + budgetMin * 60000;

const CANON_BASE = mode === 'dubbed' ? DUB : 'https://moviesda34.com';
const vaultData = V.loadVault();
const state = V.loadState();
const byPath = new Map(vaultData.map((m) => [V.pathOf(m.pageUrl), m]));
const seenThisRun = new Set();

const counts = { added: 0, merged: 0, unchanged: 0, empty: 0, failed: 0, skipped: 0, walked: 0, refresh: 0 };
const links = { targets: 0, checked: 0, dead: 0, repaired: 0, dropped: 0, unreachable: 0, pulled: 0 };
const touched = new Map();       // record id → record (for the TMDB step)
const failures = [];             // last few error lines for the summary
let listingErrors = 0;

const log = (line = '') => console.log(line);
const sameish = (a, b) => String(a).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === String(b).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pad = (s, n) => String(s).padEnd(n, ' ');
const clock = (ms) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60000)}m`);
const until = (iso) => {
  const h = Math.round((Date.parse(iso) - Date.now()) / 3.6e6);
  return h < 1 ? '<1h' : h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

const label = (record) => `${record.title}${record.year ? ` (${record.year})` : ''}`;
const countEpisodes = (record) => (record?.seasons || []).reduce((n, s) => n + s.episodes.length, 0);

function displayName(item) {
  const existing = byPath.get(item.path);
  if (existing) return `${existing.title}${existing.year ? ` (${existing.year})` : ''}`;
  if (mode === 'dubbed' && item.parsed?.title) return `${item.parsed.title}${item.parsed.year ? ` (${item.parsed.year})` : ''}`;
  const t = V.titleFor(item);
  return t ? `${t.title}${t.year ? ` (${t.year})` : ''}` : item.path;
}

/* ----------------------------------------------------------- skip or walk? */

/** Stored → skip. Checked-empty/failed recently → skip until its retry time. */
function verdict(item) {
  const known = state.done[item.url];
  if (known?.incomplete) return { walk: true, why: 'retry incomplete series walk' };

  // Recovery sweep: re-walk every page an older walker left empty, ignoring the
  // retry windows. The walk-version stamp makes this a one-time cost — once the
  // current walker has judged a page, its normal window applies again.
  if (sweepEmpty) {
    if (byPath.get(item.path)?.embeds?.length) return { skip: 'stored' };
    if (Number(known?.embeds) > 0) {
      const t = V.titleFor(item) || {};
      const rec = vaultData.find((m) => m.id === V.idFor(t.title, t.year));
      if ((known.kind || rec?.kind) !== 'series') return { skip: 'stored (another path)' };
      return { walk: true, why: 'series refresh' };
    }
    if (known?.empty) return { walk: true, why: Number(known.v || 0) < WALK_VERSION ? 'empty from the old walker' : 'empty-page sweep' };
    return { skip: 'not a tracked-empty page' };
  }

  if (onlyEmpty && !known?.empty) return { skip: 'not a tracked-empty page' };
  const stored = byPath.get(item.path);
  if (stored?.embeds?.length) {
    // A series is never "finished": the site adds episodes to a running show,
    // and one transient failure can leave an episode missing. So a stored SERIES
    // is re-walked once its window has passed (5h on the releases flow, a week
    // in the A–Z flow) and the new episodes are unioned in. Movies are done.
    if (stored.kind === 'series' && CFG.seriesRefreshHours) {
      const at = Date.parse(known?.at || '') || 0;
      const due = at + CFG.seriesRefreshHours * 3.6e6;
      if (!at || Date.now() >= due || Number(known?.v || 0) < WALK_VERSION) return { walk: true, why: 'series refresh' };
      return { skip: `series · refresh in ${until(new Date(due).toISOString())}` };
    }
    // Optional: re-walk stored movies on a long window, to pick up a re-upload
    // or a better quality. Off by default (--refresh-days=N turns it on).
    if (refreshDays) {
      const at = Date.parse(known?.at || '') || 0;
      if (!at || Date.now() - at > refreshDays * 864e5) return { walk: true, why: `movie refresh (${refreshDays}d)` };
    }
    return { skip: 'stored' };
  }

  /**
   * The site re-lists titles on extra paths (/x-2023-tamil-movie-1/,
   * /x-tamil-movie-moviesda/ …). The vault holds the record under its own
   * pageUrl, so a path lookup alone would re-walk it on every single run.
   * state.json remembers that walk — use it: a movie is done, a series still
   * follows the refresh window.
   */
  const walkedState = state.done[item.url];
  if (Number(walkedState?.embeds) > 0) {
    const t = V.titleFor(item) || {};
    const rec = vaultData.find((m) => m.id === V.idFor(t.title, t.year));
    const kind = rec?.kind || (item.kind === 'series' ? 'series' : walkedState.kind);
    if (kind !== 'series') return { skip: 'stored (another path)' };
    const at = Date.parse(walkedState.at || '') || 0;
    const due = at + CFG.seriesRefreshHours * 3.6e6;
    if (!CFG.seriesRefreshHours || !at || Date.now() >= due || Number(walkedState.v || 0) < WALK_VERSION) return { walk: true, why: 'series refresh' };
    return { skip: `series · refresh in ${until(new Date(due).toISOString())}` };
  }

  const entry = state.done[item.url];
  // A verdict written by an older walker is not trusted: the walk may have been
  // wrong (series under a movie path used to come back "empty"). Re-try now.
  if (entry?.empty && Number(entry.v || 0) < WALK_VERSION) {
    return { walk: true };
  }
  if (entry?.empty) {
    const last = Date.parse(entry.at || '') || 0;
    // A page we could not READ is retried quickly (transient). Only a page that
    // was read and genuinely had no embeds waits the empty window.
    const windowMs = entry.failures
      ? Math.min(24, 1.5 * 2 ** Math.min(entry.failures, 4)) * 3.6e6
      : CFG.emptyHours * 3.6e6;
    const due = Math.max(last + windowMs, Date.parse(entry.retryAfter || '') || 0);
    if (Date.now() < due) return { skip: `${entry.failures ? `failed ${entry.failures}×` : 'empty'} · retry in ${until(new Date(due).toISOString())}` };
  }
  return { walk: true };
}

/* --------------------------------------------------------------- file I/O */

let lastSave = 0;
let dirty = false; // did this run actually change the data since the last write?
function save(force = false) {
  if (dry) return;
  if (!force && Date.now() - lastSave < 3000) return;
  V.saveAll(vaultData, state);
  dirty = false;
  lastSave = Date.now();
}
/** Write only when something changed — a page of pure skips costs no disk at all. */
function saveIfDirty(force = false) { if (dirty || force) save(force || dirty); }

function git(argv) {
  return execFileSync('git', argv, {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024,
  }).trim();
}

const branchName = () => process.env.VAULT_BRANCH || (() => {
  try { return git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return 'main'; }
})();

const readRemote = (branch, file) => {
  try {
    // maxBuffer matters: vault.json is ~2 MB and execFileSync defaults to 1 MB,
    // which would silently fail the read and lose the other run's work.
    return JSON.parse(execFileSync('git', ['show', `origin/${branch}:data/${file}`], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    }));
  } catch { return null; }
};

/**
 * Another run pushed while we were crawling. Do NOT rebase a shallow clone and
 * do NOT force anything: merge the two generations at the JSON level (they union
 * cleanly — see mergeVaults) and commit the result on top of the remote tip, so
 * the push is a fast-forward and neither run's records are lost.
 */
function mergeRemoteIntoWorktree(branch, message) {
  git(['fetch', 'origin', branch, '--depth=1']);
  const remoteVault = readRemote(branch, 'vault.json');
  if (Array.isArray(remoteVault) && remoteVault.length) {
    const merged = V.mergeVaults(vaultData, remoteVault);
    const ours = vaultData.length;
    vaultData.length = 0; vaultData.push(...merged);
    log(`  · branch moved: merged ${ours} local + ${remoteVault.length} remote records → ${merged.length}`);
  }
  const remoteState = readRemote(branch, 'state.json');
  if (remoteState) {
    const merged = V.mergeStates(state, remoteState);
    state.done = merged.done; state.tmdbMiss = merged.tmdbMiss; state.letters = merged.letters;
  }
  const remoteAz = readRemote(branch, 'az.json');
  if (remoteAz) V.saveAz(V.mergeAz(V.loadAz(), remoteAz));
  git(['reset', '--mixed', `origin/${branch}`]);   // HEAD := remote tip, working tree untouched
  V.saveAll(vaultData, state);                     // write the merged generation
  git(['add', 'data']);
  git(['-c', 'user.name=mv-vault', '-c', 'user.email=actions@users.noreply.github.com', 'commit', '-m', `${message} (merged with a concurrent run)`]);
  git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
}

/** Returns true when the data really reached the branch. */
function commit(message) {
  if (!commitEnabled) { save(true); return true; }
  save(true);
  try {
    git(['add', 'data']);
    if (!git(['status', '--porcelain', '--', 'data'])) { log('  · nothing to commit'); return true; }
    git(['-c', 'user.name=mv-vault', '-c', 'user.email=actions@users.noreply.github.com', 'commit', '-m', message]);
    try {
      git(['push', 'origin', `HEAD:refs/heads/${branchName()}`]);
    } catch {
      log('  · another run pushed while this one was crawling — merging and pushing again');
      mergeRemoteIntoWorktree(branchName(), message);
    }
    log(`  · committed: ${message}`);
    return true;
  } catch (error) {
    const detail = String(error.message).split('\n').filter(Boolean).slice(-2).join(' / ');
    log(`  ! PUSH FAILED — the data was written locally but not published: ${detail}`);
    log('  ! rerun the workflow; nothing was corrupted and nothing was forced.');
    return false;
  }
}

/* ------------------------------------------------------------- process one */

/** Returns { walked, complete } — complete=false means the budget/limit cut it
 *  short, so an A–Z page cursor must NOT move past that page. */
async function processItems(items, label) {
  let fresh = 0;
  const processed = new Set();   // paths actually examined before any budget stop
  let complete = true;           // false when a budget/max-items limit cut the batch short
  const skipTally = new Map(); // reason → n
  const kindTotal = { movie: 0, series: 0 };
  const queue = [...new Map(items.map((i) => [i.path, i])).values()].filter((i) => !seenThisRun.has(i.path) && (!only || i.path.includes(only)));
  for (const item of queue) seenThisRun.add(item.path);
  // The stored record's kind is authoritative; the listing path is only a hint.
  const kindOf = (item) => ((byPath.get(item.path)?.kind || item.kind) === 'series' ? 'series' : 'movie');
  for (const item of queue) kindTotal[kindOf(item)] += 1;
  // Decide first (cheap), then walk the approved ones — in batches when asked.
  const approved = [];
  for (const item of queue) {
    if (deadline && Date.now() > deadline) { log(`  · ${label}: budget reached, rest of this page stays for the next run`); complete = false; break; }
    if (maxItems && counts.walked >= maxItems) { log(`  · ${label}: --max-items=${maxItems} reached`); complete = false; break; }
    const decision = verdict(item);
    if (decision.skip) {
      counts.skipped += 1;
      skipTally.set(decision.skip, (skipTally.get(decision.skip) || 0) + 1);
      processed.add(item.path);
      // Plain "stored" skips are counted in the batch summary; everything else
      // (and everything, with --verbose) gets its own line so it is never a
      // mystery why a title was not touched.
      if (verbose || decision.skip !== 'stored') {
        log(`  = ${pad(displayName(item), 40)} ${decision.skip}${verbose ? ` [${kindOf(item)}]` : ''}`);
      }
      continue;
    }
    if (decision.why) counts.refresh += 1;
    approved.push(item);
  }

  for (let qi = 0; qi < approved.length; qi += walkConcurrency) {
    if (deadline && Date.now() > deadline) { complete = false; break; }
    const slice = approved.slice(qi, qi + walkConcurrency);
    const batch = [];
    for (const item of slice) {
      processed.add(item.path);
      if (maxItems && counts.walked + batch.length >= maxItems) break;
      batch.push({ item, req: stats.requests, started: Date.now() });
    }
    const walkedRows = await Promise.all(batch.map(async (row) => {
      const req0 = stats.requests;
      try {
        const walked = mode === 'dubbed'
          ? await walkDubbed(row.item.url, { deadline, log, title: (row.item.parsed || {}).title || '', maxEpisodePages: CFG.maxEpisodePages })
          : await walkItem(row.item.url, { deadline, log });
        return { ...row, walked, reqs: stats.requests - req0 };
      } catch (error) { return { ...row, error, reqs: stats.requests - req0 }; }
    }));
    for (const row of walkedRows) {
    const item = row.item;
    if (row.error) {
      const previous = state.done[item.url] || {};
      const fails = Number(previous.failures || 0) + 1;
      state.done[item.url] = { at: new Date().toISOString(), empty: true, v: WALK_VERSION, retries: Number(previous.retries || 0), failures: fails, retryAfter: new Date(Date.now() + Math.min(24 * 3.6e6, 90 * 60000 * 2 ** Math.min(fails - 1, 4))).toISOString(), lastError: String(row.error.message).slice(0, 160) };
      counts.failed += 1; dirty = true; failures.push(`${item.path} — ${row.error.message}`);
      log(`  ! ${pad(displayName(item), 40)} ${row.error.message}`);
      continue;
    }

    try {
      const walked = row.walked;
      const n = embedCount(walked);
      dirty = true;
      const reqs = row.reqs;
      const elapsed = Date.now() - row.started;
      counts.walked += 1;
      fresh += 1;

      if (!n) {
        const previous = state.done[item.url] || {};
        const retries = Number(previous.retries || 0) + 1;
        state.done[item.url] = { at: new Date().toISOString(), empty: true, retries, v: WALK_VERSION, ...(walked.incomplete ? { incomplete: true } : {}) };
        counts.empty += 1;
        log(`  ~ ${pad(displayName(item), 40)} no embeds yet (empty #${retries}) · ${reqs} req · ${clock(elapsed)}`);
      } else {
        const title = mode === 'dubbed'
          ? (item.parsed || parseDubLabel(item.label, item.path))
          : (V.titleFor(item) || { title: displayName(item), year: 0 });
        const { action, record, previousEpisodes, note } = V.upsert(vaultData, { ...item, title: title.title, year: title.year }, walked);
        // Everything on isaiDub is a Tamil-dubbed item by definition — that is
        // site evidence, so TMDB can still replace it later.
        if (mode === 'dubbed') V.applySiteCategory(record, true);
        const gained = countEpisodes(record) - previousEpisodes;
        state.done[item.url] = { at: new Date().toISOString(), embeds: n, kind: walked.kind, v: WALK_VERSION, ...(walked.incomplete ? { incomplete: true } : {}) };
        if (record.pageUrl !== item.url) state.done[record.pageUrl] = { ...state.done[item.url] };
        byPath.set(item.path, record);
        counts[action] += 1;
        touched.set(record.id, { record, isNew: action === 'added' });
        const poster = record.poster ? 'poster' : 'no-poster';
        const symbol = action === 'added' ? '+' : action === 'merged' ? '±' : '=';
        const extra = action !== 'added' && gained > 0 ? ` · +${gained} episode${gained > 1 ? 's' : ''}` : '';
        log(`  ${symbol} ${pad(`${record.title}${record.year ? ` (${record.year})` : ''}`, 40)} ${action} · ${n} embeds${extra} · ${poster} · ${reqs} req${note ? ` · ${note}` : ''} · ${clock(elapsed)}`);
      }
    } catch (error) {
      const previous = state.done[item.url] || {};
      const fails = Number(previous.failures || 0) + 1;
      state.done[item.url] = {
        at: new Date().toISOString(), empty: true, v: WALK_VERSION,
        retries: Number(previous.retries || 0),
        failures: fails,
        retryAfter: new Date(Date.now() + Math.min(24 * 3.6e6, 90 * 60000 * 2 ** Math.min(fails - 1, 4))).toISOString(),
        lastError: String(error.message).slice(0, 160),
      };
      counts.failed += 1;
      dirty = true;
      failures.push(`${item.path} — ${error.message}`);
      log(`  ! ${pad(displayName(item), 40)} ${error.message}`);
    }

    if (counts.walked % 20 === 0) saveIfDirty(true);
    if (commitEvery && counts.walked && counts.walked % commitEvery === 0) commit(`${mode}: ${counts.walked} walks (${counts.added} new)`);
    }
  }
  // Always explain the batch: how many items were examined, of which kind, and
  // exactly why each one was skipped. "0 to walk" must never look like "ignored".
  const family = (reason) => reason.replace(/ · refresh in .*$/, ' — inside its refresh window');
  const merged = new Map();
  for (const [reason, n] of skipTally) merged.set(family(reason), (merged.get(family(reason)) || 0) + n);
  const reasons = [...merged.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(' · ');
  log(`· ${label}: ${queue.length} items (${kindTotal.movie} movies, ${kindTotal.series} series) → ${fresh} walked${reasons ? ` · skipped: ${reasons}` : ''}`);
  return { walked: fresh, complete, skipTally, processed };
}

/* ---------------------------------------------------------------- TMDB step */

async function enrichTouched() {
  if (!tmdb.hasKey()) return { checked: 0, filled: 0, skipped: true };
  const rows = [...touched.values()].filter(({ record }) => V.needsMetadata(record)).slice(0, tmdbLimit);
  let filled = 0;
  let categories = 0;
  for (const { record, isNew } of rows) {
    if (deadline && Date.now() > deadline) break;
    const meta = await enrichRecord({ ...record, kind: record.kind === 'series' ? 'series' : 'movie' });
    // undefined = could not ask (no key / rate limit / auth) → stop, never a miss
    if (meta === undefined && !tmdb.hasKey()) break;
    if (meta === undefined) { log('  ! TMDB unavailable (rate limit or auth) — enrichment stopped for this run'); break; }
    const hadCategory = record.category || '';
    if (meta && V.applyMetadata(record, meta, { preferPoster: isNew })) {
      filled += 1;
      if (record.category && record.category !== hadCategory) categories += 1;
      log(`  ★ ${pad(label(record), 40)} tmdb ${meta.tmdbId} · ${record.originalLanguage || '?'} · ${record.category || '-'}${meta.poster && !hadCategory ? ' · poster' : ''}`);
    }
    await sleep(120);
  }
  if (rows.length) save(true);
  return { checked: rows.length, filled, categories, skipped: false };
}

/* --------------------------------------------------- stored-link health check */

/**
 * A stored link can die without the page changing what it advertises: when a
 * movie's release stage changes (PreDVD → Original) the site rebuilds the files
 * and the old stream IDs answer with an EMPTY page. Nothing else would ever
 * notice — stored records are not re-walked — so the vault would keep handing
 * out dead links. This step probes the stored links of every record on this
 * year's folder and repairs the ones that are dead:
 *
 *   probe says dead  → re-walk the page → merge the fresh, verified links →
 *                      drop ONLY the URLs proven dead (everything alive stays)
 *   probe says alive → nothing happens (one request, no walk)
 *   probe unknown    → nothing happens, ever (403/429/5xx/timeout is not proof)
 *
 * `--check-all` widens it from the year folder to the whole vault.
 */
async function checkStoredLinks(items) {
  if (noLinkCheck || !CFG.linkCheck) return;
  if (deadline && Date.now() > deadline) { log('links          skipped — the run is out of budget (next run will do it)'); return; }

  const targets = [];
  const seen = new Set();
  const add = (record) => {
    if (!record || !record.embeds?.length || seen.has(record.id)) return;
    seen.add(record.id);
    if (touched.has(record.id)) return;                       // walked moments ago — already verified
    const st = state.done[record.pageUrl] || {};
    const at = Date.parse(st.at || '') || 0;
    if (at && Date.now() - at < CFG.linkCheckHours * 3.6e6) return;   // verified within the hour
    targets.push(record);
  };
  if (checkAll) vaultData.forEach(add);
  else items.forEach((item) => add(byPath.get(item.path)));

  if (!targets.length) { log('links          nothing to probe (every stored record was checked recently)'); return; }
  links.targets = targets.length;
  log(`links          probing ${targets.length} stored records${checkAll ? ' (whole vault)' : ' on this folder'} · movie=top link · series=first+newest episode`);

  const probeTargets = (record) => {
    const urls = record.embeds.map((e) => e.url);
    return record.kind === 'series' && urls.length > 1 ? [urls[0], urls[urls.length - 1]] : [urls[0]];
  };

  const suspects = [];
  await mapLimit(targets, 6, async (record) => {
    if (deadline && Date.now() > deadline) return;
    let worst = 'alive';
    for (const url of probeTargets(record)) {
      const p = await probeEmbed(url);
      links.checked += 1;
      if (p.verdict === 'dead') { worst = 'dead'; break; }
      if (p.verdict === 'unknown') worst = 'unknown';
    }
    if (worst === 'unknown') links.unreachable += 1;
    if (worst === 'dead') suspects.push(record);
  });

  for (const record of suspects) {
    if (deadline && Date.now() > deadline) { log('links          budget reached mid-repair — the rest will be done next run'); break; }
    links.dead += 1;
    // Which of THIS record's links are actually dead? Only these may be dropped.
    const probes = await mapLimit(record.embeds, 4, async (e) => ({ url: e.url, ...(await probeEmbed(e.url)) }));
    const deadUrls = probes.filter((p) => p.verdict === 'dead').map((p) => p.url);
    const unknown = probes.filter((p) => p.verdict === 'unknown').length;

    let walked = null;
    try {
      walked = mode === 'dubbed'
        ? await walkDubbed(record.pageUrl, { deadline, log: () => {}, title: record.title, maxEpisodePages: CFG.maxEpisodePages })
        : await walkItem(record.pageUrl, { deadline, log: () => {} });
    } catch (error) {
      log(`  ! ${pad(label(record), 40)} re-walk failed (${error.message.slice(0, 40)}) — nothing removed`);
      continue;
    }
    const n = walked ? embedCount(walked) : 0;
    const before = record.embeds.length;
    dirty = true;

    if (n) {
      const { record: updated } = V.upsert(vaultData, {
        url: record.pageUrl, path: V.pathOf(record.pageUrl), label: record.title, kind: record.kind,
        title: record.title, year: record.year,
      }, walked);
      const target = updated || record;
      const dropped = V.removeEmbeds(target, deadUrls);
      links.dropped += dropped;
      links.repaired += 1;
      state.done[record.pageUrl] = { at: new Date().toISOString(), embeds: target.embeds.length, kind: walked.kind || record.kind, v: WALK_VERSION };
      byPath.set(V.pathOf(record.pageUrl), target);
      touched.set(target.id, { record: target, isNew: false });
      log(`  ⚡ ${pad(label(target), 40)} DEAD LINK → re-walked · ${n} verified · ${before} stored → ${target.embeds.length} kept${dropped ? ` (${dropped} dead removed)` : ''}${unknown ? ` · ${unknown} unreachable kept` : ''}`);
    } else {
      const dropped = V.removeEmbeds(record, deadUrls);
      links.dropped += dropped;
      links.pulled += 1;
      const previous = state.done[record.pageUrl] || {};
      state.done[record.pageUrl] = { at: new Date().toISOString(), empty: true, retries: Number(previous.retries || 0) + 1, v: WALK_VERSION };
      log(`  ⚡ ${pad(label(record), 40)} DEAD LINK → page has nothing left · ${dropped} dead removed, ${record.embeds.length} kept (record stays; retried later)`);
    }
    saveIfDirty(true);
  }

  const parts = [`${links.checked} probes on ${targets.length} records`];
  if (links.dead) parts.push(`${links.dead} dead`);
  if (links.repaired) parts.push(`${links.repaired} re-walked and repaired (${links.dropped} dead links removed)`);
  if (links.pulled) parts.push(`${links.pulled} pulled from the site`);
  if (links.unreachable) parts.push(`${links.unreachable} unreachable — kept`);
  if (!links.dead) parts.push('all alive');
  log(`links          ${parts.join(' · ')}`);
}

/* ------------------------------------------------------- isaiDub discovery */

/**
 * The default incremental source: /tamil-dubbed-hollywood-movies/ is sorted by
 * date added (its first items are the same as /recent-updates/), so walking it
 * from page 1 and stopping as soon as the pages stop producing anything new is
 * self-scaling — a busy day just walks further down.
 */
async function discoverNewPage() {
  const items = [];
  const maxPages = pagesArg || CFG.listingPages;
  let barren = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    if (deadline && Date.now() > deadline) { log('  · new page paused by budget'); break; }
    const found = await discover(page === 1 ? '/tamil-dubbed-hollywood-movies/' : `/tamil-dubbed-hollywood-movies/?page=${page}`,
      { param: '', maxPages: 1, deadline, log: () => {}, host: DUB, canonBase: DUB, dubbed: true });
    const fresh = found.filter((i) => !byPath.get(i.path) && !seenThisRun.has(i.path));
    items.push(...found);
    log(`  · new page ${page}: ${found.length} items (${fresh.length} not stored)`);
    barren = fresh.length ? 0 : barren + 1;
    if (!fresh.length && (pagesArg || barren >= 3)) { log(`  · new page: nothing new on page ${page} — stopping`); break; }
    await sleep(200);
  }
  return items;
}

/** One-off / weekly: the collections index (franchise pages) + their films. */
async function discoverCollections() {
  const index = await discover('/movie/tamil-dubbed-movies-collections/', { param: 'get-page', maxPages: 40, deadline, log, host: DUB, canonBase: DUB, dubbed: true });
  const indexItems = index.filter((i) => /-collections?\/$/.test(i.path));
  log(`  · collections index: ${indexItems.length} collections`);
  const movies = [];
  await mapLimit(indexItems, 3, async (c) => {
    if (deadline && Date.now() > deadline) return;
    let html;
    try { ({ html } = await getHtml(c.url)); } catch { return; }
    for (const row of parseListing(html, c.url, { base: DUB, dubbed: true })) if (!/-collections?\/$/.test(row.path)) movies.push(row);
  });
  log(`  · collections: ${movies.length} films inside them`);
  return movies;
}

/** The whole catalogue: A–Z pages + collections + the new page + recent updates. */
async function discoverHistoric() {
  const all = new Map();
  const add = (rows) => { for (const r of rows) if (!all.has(r.path)) all.set(r.path, r); };
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    if (deadline && Date.now() > deadline) { log('  · A–Z paused by budget'); break; }
    const rows = await discover(`/tamil-atoz-dubbed-movies/${letter}`, { param: 'page', maxPages: 60, deadline, log: () => {}, host: DUB, canonBase: DUB, dubbed: true });
    add(rows);
    log(`  · A–Z ${letter}: ${rows.length} items (total ${all.size})`);
  }
  add(await discoverCollections());
  add(await discover('/tamil-dubbed-hollywood-movies/', { param: 'page', maxPages: 300, deadline, log: () => {}, host: DUB, canonBase: DUB, dubbed: true }));
  add(await discover('/recent-updates/', { param: 'page', maxPages: 1, deadline, log: () => {}, host: DUB, canonBase: DUB, dubbed: true }));
  log(`  · historic union: ${all.size} titles`);
  return [...all.values()];
}

async function runDubbed() {
  let items;
  if (manifest) {
    const paths = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    items = paths.map((p) => {
      const path = typeof p === 'string' ? p : p.path;
      const label = typeof p === 'string' ? '' : (p.label || '');
      return { path, url: `${DUB}${path}`, label, kind: 'movie', parsed: parseDubLabel(label, path) };
    });
    log(`manifest     ${items.length} titles from ${manifest}`);
  } else if (historic) {
    items = await discoverHistoric();
  } else if (deep) {
    items = [...await discoverNewPage(), ...await discoverCollections(),
      ...await discover('/tamil-atoz-dubbed-movies/a', { param: 'page', maxPages: 1, deadline, log: () => {}, host: DUB, canonBase: DUB, dubbed: true })];
  } else {
    items = await discoverNewPage();
  }
  // Labels give the real title/year; the slug is the fallback.
  for (const item of items) if (!item.parsed) item.parsed = parseDubLabel(item.label, item.path);
  if (!items.length) { listingErrors += 1; log('! nothing discovered — isaidub shape changed or it is down'); return; }
  log(`items        ${items.length} dubbed titles to consider`);
  const { walked } = await processItems(items, 'dubbed');
  log(`· ${items.length} items on isaiDub · ${walked} walked · ${counts.skipped} skipped`);
  await checkStoredLinks(items);
}

/* --------------------------------------------------------------- the modes */

async function runReleases() {
  const items = [];
  if (withSeries) {
    log(`series folder /tamil-web-series-download/ (latest ${CFG.seriesPages} pages)`);
    const seriesItems = await discover('/tamil-web-series-download/', { param: 'get-page', maxPages: CFG.seriesPages, deadline, log });
    items.push(...seriesItems);
    // Canonical current-year safety net: aliases can disappear from listings.
    for (const record of vaultData.filter((m) => m.kind === 'series' && Number(m.year) === currentYear && !V.pathOf(m.pageUrl).startsWith('/movie/')).sort((a, b) => (Date.parse(state.done[a.pageUrl]?.at || '') || 0) - (Date.parse(state.done[b.pageUrl]?.at || '') || 0))) {
      items.push({ url: record.pageUrl, path: V.pathOf(record.pageUrl), label: `${record.title} (${record.year})`, kind: 'series' });
    }
  }
  for (const y of years) {
    if (deadline && Date.now() > deadline) break;
    const found = await discover(`/tamil-${y}-movies/`, { param: 'page', maxPages: CFG.listingPages, deadline, log });
    log(`year folder   /tamil-${y}-movies/ → ${found.length} items`);
    items.push(...found);
  }
  if (!items.length) { listingErrors += 1; log('! no items discovered — the year folder(s) failed or returned nothing'); return; }
  const { walked } = await processItems(items, 'releases');
  log(`· ${items.length} items on the year folder${withSeries ? ' + series folder' : ''} · ${walked} walked · ${counts.skipped} skipped`);
  // Stored links can go dead when the site rebuilds a release — check them here,
  // because nothing else ever looks at a stored record again.
  await checkStoredLinks(items);
}

/**
 * Recovery sweep — walk a→z and re-check every page an OLDER walker left empty.
 * The cursor is not touched, so the normal A–Z flow carries on where it was.
 * Rerun it (it is budget-bound and idempotent) until it reports 0 remaining.
 */
async function runSweep() {
  const before = { added: counts.added, merged: counts.merged, empty: counts.empty, failed: counts.failed };
  let checked = 0;
  let notReached = 0;
  const stillEmpty = [];
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    if (deadline && Date.now() > deadline) { log(`· budget reached before letter ${letter} — rerun to continue the sweep (cursor untouched)`); break; }
    const items = await discover(`/tamil-movies/${letter}/`, { param: 'page', maxPages: 40, deadline, log: () => {} });
    const tracked = items.filter((i) => state.done[i.url]?.empty);
    if (!tracked.length) { log(`[${letter}] ${items.length} items · no tracked-empty pages`); continue; }
    log(`[${letter}] ${items.length} items · ${tracked.length} tracked-empty pages to re-check`);
    const { complete, processed } = await processItems(tracked, `sweep ${letter}`);
    checked += processed.size;
    notReached += tracked.length - processed.size;
    for (const item of tracked) {
      if (processed.has(item.path) && state.done[item.url]?.empty) stillEmpty.push(item.path);
    }
    if (!complete) { log('· budget reached mid-letter — rerun to continue the sweep (cursor untouched)'); break; }
  }
  const recovered = (counts.added - before.added) + (counts.merged - before.merged);
  log('');
  log(`=== sweep summary ===`);
  log(`pages re-checked ${checked}`);
  log(`recovered        ${recovered} records (${counts.added - before.added} new · ${counts.merged - before.merged} merged into existing)`);
  log(`still empty      ${counts.empty - before.empty} (genuinely nothing published yet — the page has no download links at all)`);
  if (notReached) log(`not reached      ${notReached} (budget ran out — rerun with the same command to continue)`);
  log(`failed           ${counts.failed - before.failed}`);
  if (stillEmpty.length) log(`· ${stillEmpty.length} pages are still empty — they now carry the current walker stamp and follow the normal 7-day window`);
  return null; // cursor deliberately untouched
}

/** A–Z: one letter at a time, cursor saved after every page; continues into the
 *  next letter in the SAME run. When z is done the cursor rolls back to a and a
 *  fresh pass starts, which is how new arrivals + re-uploads get re-checked. */
async function runAz() {
  if (sweepEmpty) return runSweep();
  const cursor = V.loadAz();
  let letter = /^[a-z]$/.test(cursor.letter) ? cursor.letter : 'a';
  let page = Number(cursor.page) > 0 ? Number(cursor.page) : 1;
  let pass = Number(cursor.pass) > 0 ? Number(cursor.pass) : 1;
  let lastPassAt = cursor.lastPassAt || '';
  log(`pass ${pass}${lastPassAt ? ` (last pass finished ${lastPassAt.slice(0, 16)}Z)` : ''} · resuming at letter ${letter} page ${page}`);
  const saveCursor = () => { if (!dry) V.saveAz({ letter, page, pass, ...(lastPassAt ? { lastPassAt } : {}) }); };
  let hardErrors = 0;

  while (true) {
    if (deadline && Date.now() > deadline) { log(`· budget reached at ${letter}/${page} — cursor saved`); break; }
    if (maxItems && counts.walked >= maxItems) { log('· --max-items reached'); break; }
    if (letter > 'z') {
      // ONE PASS PER RUN. This used to roll straight back to 'a' and keep going,
      // so a run over an already-stored catalogue looped the whole alphabet again
      // and again until the 5-hour budget was gone (~15 passes of pure listing
      // requests). The cursor still rolls over to a new pass — the next
      // scheduled/manual run picks it up.
      pass += 1; letter = 'a'; page = 1;
      lastPassAt = new Date().toISOString();
      saveCursor();
      log(`★ full A–Z pass ${pass - 1} complete — stopping. The next run starts pass ${pass} from 'a'.`);
      break;
    }

    const listingUrl = page > 1 ? `${LIVE}/tamil-movies/${letter}/?page=${page}` : `${LIVE}/tamil-movies/${letter}/`;
    let html;
    try {
      ({ html } = await getHtml(listingUrl));
    } catch (error) {
      hardErrors += 1;
      log(`! listing ${listingUrl} — ${error.message} (cursor NOT advanced)`);
      if (hardErrors >= 3) { log('! three listing failures in a row — stopping so the cursor is not skipped past unread pages'); break; }
      await sleep(3000);
      continue;
    }
    const items = parseListing(html, listingUrl);
    if (!items.length) {
      log(`· letter ${letter}: no more pages (page ${page}) → moving to ${String.fromCharCode(letter.charCodeAt(0) + 1)}`);
      letter = String.fromCharCode(letter.charCodeAt(0) + 1);
      page = 1;
      saveCursor();
      saveIfDirty();
      continue;
    }

    const toWalk = items.filter((i) => verdict(i).walk).length;
    log(`[${letter} p${page}] ${items.length} items · ${toWalk} to walk`);
    const { complete } = await processItems(items, `${letter}/${page}`);
    if (only) { log('· --only is a manual filter: cursor left where it was'); break; }
    if (!complete) { saveCursor(); save(true); log(`· cursor stays at ${letter}/${page} (page not finished)`); break; }
    page += 1;
    saveCursor();
    saveIfDirty();
    await sleep(300);
  }
  return { letter, page, pass };
}

/**
 * --mode=enrich — fill what the scrape alone cannot: poster, rating, tmdbId,
 * imdbId and the CATEGORY for records that are missing them.
 *
 * Reads source metadata pages for cast/director corroboration; never opens players.
 *
 * Category rules:
 *   · TMDB original_language decides: 'ta' → tamil-*, anything else → tamil-dubbed-*.
 *   · No exact TMDB match → the site's own /tamil-dubbed-movies/ section decides
 *     (listed there = dubbed), stored with categorySource: "site".
 *   · Nothing found anywhere → category stays empty; it is not guessed.
 *
 * Both paths are idempotent: run it as often as you like, with --limit to do it
 * in slices, and re-run it with --stale-days later to let TMDB upgrade the
 * site-guessed records.
 */
async function runEnrich() {
  if (!tmdb.hasKey()) {
    log('! no TMDB_KEYS / TMDB_API_KEY secret set — nothing to do');
    return { filled: 0, misses: 0, checked: 0, needsKey: true, categories: 0, siteCategories: 0, posters: 0 };
  }
  const staleDays = Number(arg('stale-days', 0)) || 0;
  const staleMs = staleDays * 86_400_000;

  const needsWork = (m) => (m.embeds || []).length && (verifyIds || V.needsMetadata(m) || V.needsCategory(m) || m.categorySource === 'site');
  const inOnly = (m) => !only || `${m.id} ${m.title} ${m.pageUrl}`.toLowerCase().includes(only.toLowerCase());
  const eligible = vaultData.filter((m) => {
    if (!inOnly(m)) return false;   // `--only=` also works here, to fix one title by hand
    if (!needsWork(m)) return false;
    const missed = Date.parse(state.tmdbMiss?.[m.id] || '') || 0;
    // No category at all → always eligible. A "no match" marker only says TMDB
    // has no entry; it must never stop the site-fallback category from being set
    // (that mismatch is how records end up marked but uncategorised).
    if (verifyIds || args.includes('--retry-misses') || V.needsCategory(m)) return true;
    if (!missed) return true;                          // never tried
    return staleMs > 0 && Date.now() - missed > staleMs; // tried before, retry if asked
  });
  const queue = eligible.slice(0, Number(arg('limit', 0)) || eligible.length);
  log(`records missing poster/rating/category: ${vaultData.filter(needsWork).length} · eligible now: ${eligible.length} · this run: ${queue.length}`);

  // Site evidence for the dubbed fallback: one read of the dubbed section.
  let dubbed = new Set();
  if (queue.length) {
    const rows = await discover('/tamil-dubbed-movies/', { param: 'page', maxPages: 6, deadline, log });
    dubbed = new Set(rows.map((r) => r.path));
    log(`dubbed section: ${dubbed.size} paths kept as evidence`);
  }

  const audit = [];
  const reportPath = arg('report', '');
  let checked = 0; let filled = 0; let posters = 0; let categories = 0; let siteCategories = 0; let misses = 0; let blips = 0;
  const parallel = Math.max(1, Math.min(Number(arg('concurrency', 4)) || 4, 8));
  log(`tmdb ${tmdb.keyStatus()} · ${parallel} parallel lookups`);

  for (let i = 0; i < queue.length; i += parallel) {
    if (deadline && Date.now() > deadline) { log('· budget reached'); break; }
    const batch = queue.slice(i, i + parallel);
    const results = await Promise.all(batch.map(async (record) => ({
      record,
      meta: await enrichRecord({ ...record, kind: record.kind === 'series' ? 'series' : 'movie', verifyIds }),
    })));

    let stop = false;
    for (const { record, meta } of results) {
      checked += 1;
      audit.push({ id: record.id, title: record.title, year: record.year, status: meta === undefined ? 'unavailable' : meta ? 'matched' : 'unresolved', ...(meta ? { tmdbId: meta.tmdbId, tmdbType: meta.tmdbType, tmdbTitle: meta.tmdbTitle, match: meta.match, originalYear: meta.originalYear, ...(meta.evidence ? { evidence: meta.evidence } : {}) } : {}) });
      const wasPoster = Boolean(record.poster);
      const wasCategory = record.category || '';
      if (meta === undefined) {
        if (tmdb.isAuthFailed()) { log(`! every TMDB key was rejected — stopping; nothing was marked. Keys: ${tmdb.keyStatus()}`); stop = true; break; }
        if (tmdb.cooldownActive()) { log(`! all TMDB keys are rate-limited — stopping; nothing was marked, rerun in a few minutes (${tmdb.keyStatus()})`); stop = true; break; }
        blips += 1;
        if (blips >= 5) { log('! 5 incomplete/unavailable TMDB lookups in a row — stopping; nothing was marked, rerun to continue'); stop = true; break; }
        log(`  · TMDB lookup incomplete/unavailable (${blips}/5) — skipping this one, continuing`);
        continue;
      }
      blips = 0;
      if (meta) {
        if (meta.crossType) {
          log(`  · ${pad(label(record), 40)} TMDB id ${meta.tmdbId} is "${meta.tmdbTitle}", a ${meta.tmdbType === 'tv' ? 'series' : 'film'} — categorised as one`);
        } else if (meta.tmdbTitle && !sameish(meta.tmdbTitle, record.title)) {
          log(`  · ${pad(label(record), 40)} TMDB id ${meta.tmdbId} is "${meta.tmdbTitle}" — ${meta.match === 'stored-id' ? 'stored ID retained (use --verify-ids to re-match)' : 'matched through verified title/season evidence'}`);
        }
        if (V.applyMetadata(record, meta, { preferPoster: true, replaceId: verifyIds })) {
          filled += 1;
          if (!wasPoster && record.poster) posters += 1;
          if (record.category && record.category !== wasCategory) categories += 1;
          log(`  ★ ${pad(label(record), 40)} tmdb ${record.tmdbId || meta.tmdbId} · ${record.originalLanguage || '?'} · ${record.category}${!wasPoster && record.poster ? ' · poster' : ''}`);
        }
        delete state.tmdbMiss?.[record.id];
      } else {
        // no exact TMDB match → the site's dubbed section is the fallback evidence
        misses += 1;
        state.tmdbMiss = state.tmdbMiss || {};
        state.tmdbMiss[record.id] = new Date().toISOString();
        const path = V.pathOf(record.pageUrl);
        if (dubbed.has(path) && V.applySiteCategory(record, true)) {
          siteCategories += 1;
          if (record.category !== wasCategory) categories += 1;
          log(`  · ${pad(label(record), 40)} no TMDB match → site says ${record.category}`);
        } else {
          log(`  · ${pad(label(record), 40)} no safe TMDB match — existing metadata preserved`);
        }
      }
    }
    if (reportPath && !dry) V.writeJson(reportPath, audit);
    if (stop) break;
    if ((filled + misses) % 100 < parallel) save(true);
    await sleep(80);
  }
  log(`enrich         ${filled} filled (${posters} posters) · ${categories} categories (${siteCategories} from the site) · ${misses} no TMDB match · ${queue.length - checked} not reached`);
  return { filled, posters, categories, siteCategories, misses, checked, needsKey: false };
}

/* -------------------------------------------------------------------- main */

log(`=== mv_vault · ${mode}${sweepEmpty ? ' · sweep-empty' : ''} · ${new Date().toISOString()} ===`);
log(`budget ${budgetMin}min · max-items ${maxItems || '∞'} · tmdb ${tmdb.hasKey() ? `on (${tmdb.keyStatus()})` : 'off'}${mode === 'releases' ? ` · years ${years.join(' + ')}` : ''}${mode === 'dubbed' ? ` · source isaidub.green${historic ? ' · HISTORIC' : deep ? ' · deep' : ''}${walkConcurrency > 1 ? ` · ${walkConcurrency} walks at once` : ''}` : ''}${dry ? ' · DRY RUN (nothing is written)' : ''}`);
log(`vault ${vaultData.length} records · state ${Object.keys(state.done).length} tracked urls`);

let azCursor = null;
let backfill = null;
try {
  if (mode === 'releases') await runReleases();
  else if (mode === 'dubbed') await runDubbed();
  else if (mode === 'az') azCursor = await runAz();
  else backfill = await runEnrich();
} catch (error) {
  listingErrors += 1;
  log(`! run aborted: ${error.stack || error.message}`);
}

const tmdbStats = mode === 'enrich'
  ? { checked: backfill?.checked ?? 0, filled: backfill?.filled ?? 0, skipped: Boolean(backfill?.needsKey) }
  : await enrichTouched();
save(true);
const totals = vaultData.reduce((acc, m) => {
  acc.embeds += (m.embeds || []).length;
  if (m.kind === 'series') acc.series += 1; else acc.movies += 1;
  return acc;
}, { movies: 0, series: 0, embeds: 0 });
const minutes = Math.round((Date.now() - started) / 60000);
const stopped = Date.now() >= deadline;

log('');
log(`=== summary · ${mode} · pass ${azCursor?.pass ?? ''} ===`.replace(' · pass  ===', ' ==='));
if (azCursor) log(`cursor         ${azCursor.letter}/${azCursor.page}`);
log(`items walked   ${counts.walked}  (added ${counts.added} · merged ${counts.merged} · unchanged ${counts.unchanged})`);
log(`empty/failed   ${counts.empty} empty · ${counts.failed} failed · ${counts.skipped} skipped (already stored/recent)`);
if (counts.refresh) log(`series refresh ${counts.refresh} stored series re-walked for new episodes`);
log(`tmdb           ${backfill
  ? (backfill.needsKey ? 'no key set — nothing done' : `${backfill.filled} records filled · ${backfill.categories} categories (${backfill.siteCategories} from site) · ${backfill.misses} no exact match`)
  : tmdbStats.skipped ? 'skipped (no key)' : `${tmdbStats.checked} checked · ${tmdbStats.filled} filled`}`);
log(`http           ${stats.requests} requests · ${stats.retries} retries · ${stats.failures} gave up · ${(stats.bytes / 1e6).toFixed(1)} MB`);
const cat = vaultData.reduce((acc, m) => { if (m.category) acc[m.category] = (acc[m.category] || 0) + 1; return acc; }, {});
const catLine = Object.keys(cat).length ? Object.entries(cat).map(([k, v]) => `${k} ${v}`).join(' · ') : 'none yet (run --mode=enrich)';
log(`vault          ${vaultData.length} records (${totals.movies} movies · ${totals.series} series) · ${totals.embeds} embeds`);
log(`categories     ${catLine}`);
if (CFG.linkCheck && !noLinkCheck) {
  log(`links          ${links.targets} checked · ${links.dead} dead · ${links.repaired} repaired · ${links.dropped} removed · ${links.pulled} pulled · ${links.unreachable} unreachable-kept`);
}
log(`duration       ${minutes}m${stopped ? ' · stopped by budget' : ''}${dry ? ' · DRY RUN' : ''}`);
if (failures.length) { log('failures'); for (const line of failures.slice(-10)) log(`  ! ${line}`); }

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    `## mv_vault · ${mode}${azCursor ? ` · pass ${azCursor.pass} (cursor ${azCursor.letter}/${azCursor.page})` : ''}`,
    '',
    `| walked | added | merged | unchanged | empty | failed | skipped | requests | duration |`,
    `|---|---|---|---|---|---|---|---|---|`,
    `| ${counts.walked} | ${counts.added} | ${counts.merged} | ${counts.unchanged} | ${counts.empty} | ${counts.failed} | ${counts.skipped} | ${stats.requests} | ${minutes}m${stopped ? ' (budget)' : ''} |`,
    '',
    `vault: **${vaultData.length}** records · ${totals.movies} movies · ${totals.series} series · ${totals.embeds} embeds`,
    `tmdb: ${tmdbStats.skipped ? 'skipped (no key)' : `${tmdbStats.checked} checked, ${tmdbStats.filled} filled`}`,
    ...(CFG.linkCheck && !noLinkCheck
      ? [`links: ${links.checked} probes · ${links.dead} dead · ${links.repaired} repaired · ${links.dropped} removed · ${links.unreachable} unreachable (kept)`]
      : []),
    failures.length ? `\n**last failures**\n${failures.slice(-5).map((f) => `- \`${f}\``).join('\n')}` : '',
  ].join('\n');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

const published = commit(`${mode}: +${counts.added} new, ${counts.merged} merged, ${counts.walked} walks`);
if (!published) process.exitCode = 1;

/* A red run means "the site changed shape or is down", not "one item failed". */
const stored = counts.added + counts.merged + counts.unchanged;
if (mode === 'enrich' && backfill?.needsKey) {
  log('! enrich mode needs the TMDB_KEYS secret; nothing was changed.');
  process.exitCode = 1;
} else if (counts.walked >= 10 && stored === 0) {
  log(`! ${counts.walked} items were walked and NONE produced embeds — the hop chain or the site changed. Nothing was lost; check the log above.`);
  process.exitCode = 1;
} else if (listingErrors && counts.walked === 0) {
  log('! no listing could be read this run — check the host/reachability.');
  process.exitCode = 1;
}
