#!/usr/bin/env node
/**
 * run.mjs — THE run. Two modes, one job each, no stages:
 *
 *   node src/run.mjs --mode=releases     # Tamil 2026 folder + latest series folder
 *   node src/run.mjs --mode=az           # A–Z folder, resumable, goes on to the next letter
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
 *   --refresh-days=N   also re-walk stored MOVIES older than N days (default 0 =
 *                      never; movies are normally done once they are stored)
 *   --concurrency=N    enrich mode: parallel TMDB lookups (default 4)
 *   --limit=N          enrich mode: max records this run
 *   --stale-days=N     enrich mode: also re-try records last looked at N+ days ago
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { LIVE, discover, getHtml, parseListing, walkItem, embedCount, stats, sleep, WALK_VERSION } from './scrape.mjs';
import * as V from './vault.mjs';
import * as tmdb from './tmdb.mjs';

/* ------------------------------------------------------------------- setup */

const args = process.argv.slice(2);
const arg = (key, fallback = null) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? (args.includes(`--${key}`) ? true : fallback);
const mode = arg('mode', 'releases') === 'tmdb' ? 'enrich' : arg('mode', 'releases'); // 'tmdb' kept as an alias
if (!['releases', 'az', 'enrich'].includes(mode)) { console.error('usage: --mode=releases | --mode=az | --mode=enrich'); process.exit(2); }
const dry = Boolean(arg('dry', false));
const commitEnabled = Boolean(arg('commit', false)) && !dry;
const only = arg('only', '');
const onlyEmpty = Boolean(arg('only-empty', false));
const sweepEmpty = Boolean(arg('sweep-empty', false));
const verbose = Boolean(arg('verbose', false)) || /^(1|true)$/i.test(String(process.env.VERBOSE || ''));
const refreshDays = Number(arg('refresh-days', 0)) || 0;
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
  ? { budgetMin: 25, maxItems: 0, commitEvery: 100, emptyHours: 24, listingPages: 30, seriesPages: 3, seriesRefreshHours: 24 }
  : mode === 'enrich'
    ? { budgetMin: 20, maxItems: 0, commitEvery: 500, emptyHours: 0, listingPages: 0, seriesPages: 0, seriesRefreshHours: 0 }
    : { budgetMin: 300, maxItems: 0, commitEvery: 200, emptyHours: 168, listingPages: 1, seriesPages: 0, seriesRefreshHours: 168 };

const budgetMin = Number(arg('budget-min', CFG.budgetMin));
const maxItems = Number(arg('max-items', CFG.maxItems)) || 0;
const commitEvery = Number(arg('commit-every', CFG.commitEvery)) || 0;
const tmdbLimit = Number(arg('tmdb-limit', 150));
const started = Date.now();
const deadline = started + budgetMin * 60000;

const vaultData = V.loadVault();
const state = V.loadState();
const byPath = new Map(vaultData.map((m) => [V.pathOf(m.pageUrl), m]));
const seenThisRun = new Set();

const counts = { added: 0, merged: 0, unchanged: 0, empty: 0, failed: 0, skipped: 0, walked: 0, refresh: 0 };
const touched = new Map();       // record id → record (for the TMDB step)
const failures = [];             // last few error lines for the summary
let listingErrors = 0;

const log = (line = '') => console.log(line);
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
  const t = V.titleFor(item);
  return t ? `${t.title}${t.year ? ` (${t.year})` : ''}` : item.path;
}

/* ----------------------------------------------------------- skip or walk? */

/** Stored → skip. Checked-empty/failed recently → skip until its retry time. */
function verdict(item) {
  const known = state.done[item.url];

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
    // is re-walked once its window has passed (24h on the releases flow, a week
    // in the A–Z flow) and the new episodes are unioned in. Movies are done.
    if (stored.kind === 'series' && CFG.seriesRefreshHours) {
      const at = Date.parse(known?.at || '') || 0;
      const due = at + CFG.seriesRefreshHours * 3.6e6;
      if (!at || Date.now() >= due) return { walk: true, why: 'series refresh' };
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
    const kind = walkedState.kind || rec?.kind;
    if (kind !== 'series') return { skip: 'stored (another path)' };
    const at = Date.parse(walkedState.at || '') || 0;
    const due = at + CFG.seriesRefreshHours * 3.6e6;
    if (!CFG.seriesRefreshHours || !at || Date.now() >= due) return { walk: true, why: 'series refresh' };
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
  const queue = items.filter((i) => !seenThisRun.has(i.path) && (!only || i.path.includes(only)));
  for (const item of queue) seenThisRun.add(item.path);
  // The stored record's kind is authoritative; the listing path is only a hint.
  const kindOf = (item) => ((byPath.get(item.path)?.kind || item.kind) === 'series' ? 'series' : 'movie');
  for (const item of queue) kindTotal[kindOf(item)] += 1;
  for (const item of queue) {
    if (deadline && Date.now() > deadline) { log(`  · ${label}: budget reached, rest of this page stays for the next run`); complete = false; break; }
    processed.add(item.path);
    if (maxItems && counts.walked >= maxItems) { log(`  · ${label}: --max-items=${maxItems} reached`); complete = false; break; }

    const decision = verdict(item);
    if (decision.skip) {
      counts.skipped += 1;
      skipTally.set(decision.skip, (skipTally.get(decision.skip) || 0) + 1);
      // Plain "stored" skips are counted in the batch summary; everything else
      // (and everything, with --verbose) gets its own line so it is never a
      // mystery why a title was not touched.
      if (verbose || decision.skip !== 'stored') {
        log(`  = ${pad(displayName(item), 40)} ${decision.skip}${verbose ? ` [${kindOf(item)}]` : ''}`);
      }
      continue;
    }
    if (decision.why) counts.refresh += 1;

    const before = { req: stats.requests, t: Date.now() };
    try {
      const walked = await walkItem(item.url, { deadline, log });
      const n = embedCount(walked);
      dirty = true;
      const reqs = stats.requests - before.req;
      counts.walked += 1;
      fresh += 1;

      if (!n) {
        const previous = state.done[item.url] || {};
        const retries = Number(previous.retries || 0) + 1;
        state.done[item.url] = { at: new Date().toISOString(), empty: true, retries, v: WALK_VERSION };
        counts.empty += 1;
        log(`  ~ ${pad(displayName(item), 40)} no embeds yet (empty #${retries}) · ${reqs} req · ${clock(Date.now() - before.t)}`);
      } else {
        const title = V.titleFor(item) || { title: displayName(item), year: 0 };
        const { action, record, previousEpisodes } = V.upsert(vaultData, { ...item, ...title }, walked);
        const gained = countEpisodes(record) - previousEpisodes;
        state.done[item.url] = { at: new Date().toISOString(), embeds: n, kind: walked.kind, v: WALK_VERSION };
        byPath.set(item.path, record);
        counts[action] += 1;
        touched.set(record.id, { record, isNew: action === 'added' });
        const poster = record.poster ? 'poster' : 'no-poster';
        const symbol = action === 'added' ? '+' : action === 'merged' ? '±' : '=';
        const extra = action !== 'added' && gained > 0 ? ` · +${gained} episode${gained > 1 ? 's' : ''}` : '';
        log(`  ${symbol} ${pad(`${record.title}${record.year ? ` (${record.year})` : ''}`, 40)} ${action} · ${n} embeds${extra} · ${poster} · ${reqs} req · ${clock(Date.now() - before.t)}`);
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
    const meta = await tmdb.enrich({ title: record.title, year: record.year, kind: record.kind === 'series' ? 'series' : 'movie' });
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

/* --------------------------------------------------------------- the modes */

async function runReleases() {
  const items = [];
  for (const y of years) {
    if (deadline && Date.now() > deadline) break;
    const found = await discover(`/tamil-${y}-movies/`, { param: 'page', maxPages: CFG.listingPages, deadline, log });
    log(`year folder   /tamil-${y}-movies/ → ${found.length} items`);
    items.push(...found);
  }
  log(`series folder /tamil-web-series-download/ (latest ${CFG.seriesPages} pages only)`);
  const seriesItems = await discover('/tamil-web-series-download/', { param: 'get-page', maxPages: CFG.seriesPages, deadline, log });
  items.push(...seriesItems);
  if (!items.length) { listingErrors += 1; log('! no items discovered — both listings failed or returned nothing'); return; }
  const { walked } = await processItems(items, 'releases');
  log(`· ${items.length} items on the listings · ${walked} walked · ${counts.skipped} skipped`);
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
 * No site scraping (apart from reading the dubbed section once as evidence).
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

  const needsWork = (m) => (m.embeds || []).length && (V.needsMetadata(m) || V.needsCategory(m) || m.categorySource === 'site');
  const eligible = vaultData.filter((m) => {
    if (!needsWork(m)) return false;
    const missed = Date.parse(state.tmdbMiss?.[m.id] || '') || 0;
    // No category at all → always eligible. A "no match" marker only says TMDB
    // has no entry; it must never stop the site-fallback category from being set
    // (that mismatch is how records end up marked but uncategorised).
    if (V.needsCategory(m)) return true;
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

  let filled = 0; let posters = 0; let categories = 0; let siteCategories = 0; let misses = 0; let blips = 0;
  const parallel = Math.max(1, Math.min(Number(arg('concurrency', 4)) || 4, 8));
  log(`tmdb ${tmdb.keyStatus()} · ${parallel} parallel lookups`);

  for (let i = 0; i < queue.length; i += parallel) {
    if (deadline && Date.now() > deadline) { log('· budget reached'); break; }
    const batch = queue.slice(i, i + parallel);
    const results = await Promise.all(batch.map(async (record) => ({
      record,
      meta: await tmdb.enrich({ title: record.title, year: record.year, kind: record.kind === 'series' ? 'series' : 'movie', tmdbId: record.tmdbId }),
    })));

    let stop = false;
    for (const { record, meta } of results) {
      const wasPoster = Boolean(record.poster);
      const wasCategory = record.category || '';
      if (meta === undefined) {
        if (tmdb.isAuthFailed()) { log(`! every TMDB key was rejected — stopping; nothing was marked. Keys: ${tmdb.keyStatus()}`); stop = true; break; }
        if (tmdb.cooldownActive()) { log(`! all TMDB keys are rate-limited — stopping; nothing was marked, rerun in a few minutes (${tmdb.keyStatus()})`); stop = true; break; }
        blips += 1;
        if (blips >= 5) { log('! 5 TMDB network errors in a row — stopping; nothing was marked, rerun to continue'); stop = true; break; }
        log(`  · TMDB network error (${blips}/5) — skipping this one, continuing`);
        continue;
      }
      blips = 0;
      if (meta) {
        if (V.applyMetadata(record, meta, { preferPoster: true })) {
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
        if (V.applySiteCategory(record, dubbed.has(path))) {
          siteCategories += 1;
          if (record.category !== wasCategory) categories += 1;
          log(`  · ${pad(label(record), 40)} no TMDB match → site says ${record.category}`);
        } else {
          log(`  · ${pad(label(record), 40)} no TMDB match — left uncategorised`);
        }
      }
    }
    if (stop) break;
    if ((filled + misses) % 100 < parallel) save(true);
    await sleep(80);
  }
  log(`enrich         ${filled} filled (${posters} posters) · ${categories} categories (${siteCategories} from the site) · ${misses} no TMDB match · ${queue.length - filled - misses} not reached`);
  return { filled, posters, categories, siteCategories, misses, checked: queue.length, needsKey: false };
}

/* -------------------------------------------------------------------- main */

log(`=== mv_vault · ${mode}${sweepEmpty ? ' · sweep-empty' : ''} · ${new Date().toISOString()} ===`);
log(`budget ${budgetMin}min · max-items ${maxItems || '∞'} · tmdb ${tmdb.hasKey() ? `on (${tmdb.keyStatus()})` : 'off'}${mode === 'releases' ? ` · years ${years.join(' + ')}` : ''}${dry ? ' · DRY RUN (nothing is written)' : ''}`);
log(`vault ${vaultData.length} records · state ${Object.keys(state.done).length} tracked urls`);

let azCursor = null;
let backfill = null;
try {
  if (mode === 'releases') await runReleases();
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
