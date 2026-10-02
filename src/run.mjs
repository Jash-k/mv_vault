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
 *   --year=2027        pin the releases flow to one year (skips the current year)
 *   --tmdb-limit=N     max TMDB lookups per run (default 150)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { LIVE, discover, getHtml, parseListing, walkItem, embedCount, stats, sleep } from './scrape.mjs';
import * as V from './vault.mjs';
import * as tmdb from './tmdb.mjs';

/* ------------------------------------------------------------------- setup */

const args = process.argv.slice(2);
const arg = (key, fallback = null) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? (args.includes(`--${key}`) ? true : fallback);
const mode = arg('mode', 'releases');
if (!['releases', 'az', 'tmdb'].includes(mode)) { console.error('usage: --mode=releases | --mode=az | --mode=tmdb'); process.exit(2); }
const dry = Boolean(arg('dry', false));
const commitEnabled = Boolean(arg('commit', false)) && !dry;
const only = arg('only', '');
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
  ? { budgetMin: 25, maxItems: 0, commitEvery: 100, emptyHours: 24, listingPages: 30, seriesPages: 3 }
  : mode === 'tmdb'
    ? { budgetMin: 20, maxItems: 0, commitEvery: 500, emptyHours: 0, listingPages: 0, seriesPages: 0 }
    : { budgetMin: 300, maxItems: 0, commitEvery: 200, emptyHours: 168, listingPages: 1, seriesPages: 0 };

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

const counts = { added: 0, merged: 0, unchanged: 0, empty: 0, failed: 0, skipped: 0, walked: 0 };
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

function displayName(item) {
  const existing = byPath.get(item.path);
  if (existing) return `${existing.title}${existing.year ? ` (${existing.year})` : ''}`;
  const t = V.titleFor(item);
  return t ? `${t.title}${t.year ? ` (${t.year})` : ''}` : item.path;
}

/* ----------------------------------------------------------- skip or walk? */

/** Stored → skip. Checked-empty/failed recently → skip until its retry time. */
function verdict(item) {
  if (byPath.get(item.path)?.embeds?.length) return { skip: 'stored' };
  const entry = state.done[item.url];
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
function save(force = false) {
  if (dry) return;
  if (!force && Date.now() - lastSave < 3000) return;
  V.saveAll(vaultData, state);
  lastSave = Date.now();
}

function git(argv) {
  return execFileSync('git', argv, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(message) {
  if (!commitEnabled) return;
  save(true);
  try {
    git(['add', 'data']);
    if (!git(['status', '--porcelain', '--', 'data'])) return;
    git(['-c', 'user.name=mv-vault', '-c', 'user.email=actions@users.noreply.github.com', 'commit', '-m', message]);
    try {
      git(['push']);
    } catch {
      log('  · push raced another writer — rebasing and retrying once');
      git(['pull', '--rebase', '--autostash']);
      git(['push']);
    }
    log(`  · committed: ${message}`);
  } catch (error) {
    log(`  ! git commit failed: ${String(error.message).split('\n')[0]}`);
  }
}

/* ------------------------------------------------------------- process one */

/** Returns { walked, complete } — complete=false means the budget/limit cut it
 *  short, so an A–Z page cursor must NOT move past that page. */
async function processItems(items, label) {
  let fresh = 0;
  const queue = items.filter((i) => !seenThisRun.has(i.path) && (!only || i.path.includes(only)));
  for (const item of queue) seenThisRun.add(item.path);
  for (const item of queue) {
    if (deadline && Date.now() > deadline) { log(`  · ${label}: budget reached, rest of this page stays for the next run`); return { walked: fresh, complete: false }; }
    if (maxItems && counts.walked >= maxItems) return { walked: fresh, complete: false };

    const decision = verdict(item);
    if (decision.skip) {
      counts.skipped += 1;
      if (decision.skip !== 'stored') log(`  = ${pad(displayName(item), 40)} ${decision.skip}`);
      continue;
    }

    const before = { req: stats.requests, t: Date.now() };
    try {
      const walked = await walkItem(item.url, { deadline, log });
      const n = embedCount(walked);
      const reqs = stats.requests - before.req;
      counts.walked += 1;
      fresh += 1;

      if (!n) {
        const previous = state.done[item.url] || {};
        const retries = Number(previous.retries || 0) + 1;
        state.done[item.url] = { at: new Date().toISOString(), empty: true, retries };
        counts.empty += 1;
        log(`  ~ ${pad(displayName(item), 40)} no embeds yet (empty #${retries}) · ${reqs} req · ${clock(Date.now() - before.t)}`);
      } else {
        const title = V.titleFor(item) || { title: displayName(item), year: 0 };
        const { action, record } = V.upsert(vaultData, { ...item, ...title }, walked);
        state.done[item.url] = { at: new Date().toISOString(), embeds: n };
        byPath.set(item.path, record);
        counts[action] += 1;
        touched.set(record.id, { record, isNew: action === 'added' });
        const poster = record.poster ? 'poster' : 'no-poster';
        const symbol = action === 'added' ? '+' : action === 'merged' ? '±' : '=';
        log(`  ${symbol} ${pad(`${record.title}${record.year ? ` (${record.year})` : ''}`, 40)} ${action} · ${n} embeds · ${poster} · ${reqs} req · ${clock(Date.now() - before.t)}`);
      }
    } catch (error) {
      const previous = state.done[item.url] || {};
      const fails = Number(previous.failures || 0) + 1;
      state.done[item.url] = {
        at: new Date().toISOString(), empty: true,
        retries: Number(previous.retries || 0),
        failures: fails,
        retryAfter: new Date(Date.now() + Math.min(24 * 3.6e6, 90 * 60000 * 2 ** Math.min(fails - 1, 4))).toISOString(),
        lastError: String(error.message).slice(0, 160),
      };
      counts.failed += 1;
      failures.push(`${item.path} — ${error.message}`);
      log(`  ! ${pad(displayName(item), 40)} ${error.message}`);
    }

    if (counts.walked % 20 === 0) save();
    if (commitEvery && counts.walked && counts.walked % commitEvery === 0) commit(`${mode}: ${counts.walked} walks (${counts.added} new)`);
  }
  return { walked: fresh, complete: true };
}

/* ---------------------------------------------------------------- TMDB step */

async function enrichTouched() {
  if (!tmdb.hasKey()) return { checked: 0, filled: 0, skipped: true };
  const rows = [...touched.values()].filter(({ record }) => V.needsMetadata(record)).slice(0, tmdbLimit);
  let filled = 0;
  for (const { record, isNew } of rows) {
    if (deadline && Date.now() > deadline) break;
    const meta = await tmdb.enrich({ title: record.title, year: record.year, kind: record.kind === 'series' ? 'series' : 'movie' });
    // undefined = could not ask (no key / rate limit / auth) → stop, never a miss
    if (meta === undefined && !tmdb.hasKey()) break;
    if (meta === undefined) { log('  ! TMDB unavailable (rate limit or auth) — enrichment stopped for this run'); break; }
    if (meta && V.applyMetadata(record, meta, { preferPoster: isNew })) {
      filled += 1;
      log(`  ★ ${pad(`${record.title}${record.year ? ` (${record.year})` : ''}`, 40)} tmdb ${meta.tmdbId} · rating ${meta.rating || 0}${meta.poster ? ' · poster' : ''}`);
    }
    await sleep(120);
  }
  if (rows.length) save(true);
  return { checked: rows.length, filled, skipped: false };
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

/** A–Z: one letter at a time, cursor saved after every page; continues into the
 *  next letter in the SAME run. When z is done the cursor rolls back to a and a
 *  fresh pass starts, which is how new arrivals + re-uploads get re-checked. */
async function runAz() {
  const cursor = V.loadAz();
  let letter = /^[a-z]$/.test(cursor.letter) ? cursor.letter : 'a';
  let page = Number(cursor.page) > 0 ? Number(cursor.page) : 1;
  let pass = Number(cursor.pass) > 0 ? Number(cursor.pass) : 1;
  log(`pass ${pass} · resuming at letter ${letter} page ${page}`);
  const saveCursor = () => { if (!dry) V.saveAz({ letter, page, pass }); };
  let hardErrors = 0;

  while (true) {
    if (deadline && Date.now() > deadline) { log(`· budget reached at ${letter}/${page} — cursor saved`); break; }
    if (maxItems && counts.walked >= maxItems) { log('· --max-items reached'); break; }
    if (letter > 'z') {
      pass += 1; letter = 'a'; page = 1;
      saveCursor();
      log(`★ full A–Z pass ${pass - 1} complete — starting pass ${pass} from 'a'`);
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
      save();
      continue;
    }

    const toWalk = items.filter((i) => verdict(i).walk).length;
    log(`[${letter} p${page}] ${items.length} items · ${toWalk} to walk`);
    const { complete } = await processItems(items, `${letter}/${page}`);
    if (only) { log('· --only is a manual filter: cursor left where it was'); break; }
    if (!complete) { saveCursor(); save(true); log(`· cursor stays at ${letter}/${page} (page not finished)`); break; }
    page += 1;
    saveCursor();
    save();
    await sleep(300);
  }
  return { letter, page, pass };
}

/**
 * --mode=tmdb — one-off backfill for records that are missing artwork.
 *
 * Entirely separate from scraping: no site requests, one TMDB call per record,
 * and a shared "attempted, nothing found" marker in state.json
 * (`tmdbMiss: {<record id>: ISO}`) so a record TMDB simply does not have is not
 * retried on every run. A bad key / rate limit stops the loop instead of
 * burning through the whole vault marking things as misses.
 */
async function runTmdbBackfill() {
  if (!tmdb.hasKey()) {
    log('! no TMDB_KEYS / TMDB_API_KEY secret set — nothing to do');
    return { filled: 0, misses: 0, checked: 0, needsKey: true };
  }
  const missing = vaultData.filter((m) => (m.embeds || []).length && V.needsMetadata(m));
  const stale = Number(arg('stale-days', 0)) || 0;
  const eligible = missing.filter((m) => {
    const at = Date.parse(state.tmdbMiss?.[m.id] || '') || 0;
    return !at || (stale && Date.now() - at > stale * 86_400_000);
  });
  const queue = eligible.slice(0, Number(arg('limit', 0)) || eligible.length);
  log(`records missing artwork: ${missing.length} · eligible now: ${eligible.length} · this run: ${queue.length}`);

  let filled = 0;
  let misses = 0;
  let consecutiveErrors = 0;
  for (const record of queue) {
    if (deadline && Date.now() > deadline) { log('· budget reached'); break; }
    const meta = await tmdb.enrich({ title: record.title, year: record.year, kind: record.kind === 'series' ? 'series' : 'movie' });
    if (meta === undefined) {
      consecutiveErrors += 1;
      log(`! TMDB unavailable (${tmdb.isAuthFailed() ? 'auth rejected' : tmdb.cooldownActive() ? 'rate limited' : 'network'}) — stopping; the rest keep their state`);
      break;
    }
    consecutiveErrors = 0;
    if (meta) {
      if (V.applyMetadata(record, meta, { preferPoster: true })) {
        filled += 1;
        log(`  ★ ${pad(`${record.title}${record.year ? ` (${record.year})` : ''}`, 40)} tmdb ${meta.tmdbId} · rating ${meta.rating || 0}${meta.poster ? ' · poster' : ''}`);
      }
      delete state.tmdbMiss?.[record.id];
    } else {
      misses += 1;
      state.tmdbMiss = state.tmdbMiss || {};
      state.tmdbMiss[record.id] = new Date().toISOString();
      log(`  · ${pad(`${record.title}${record.year ? ` (${record.year})` : ''}`, 40)} no exact TMDB match — not retried`);
    }
    if ((filled + misses) % 100 === 0) save(true);
    await sleep(120);
  }
  log(`tmdb backfill  ${filled} filled · ${misses} no match · ${queue.length - filled - misses} not reached`);
  return { filled, misses, checked: queue.length, needsKey: false };
}

/* -------------------------------------------------------------------- main */

log(`=== mv_vault · ${mode} · ${new Date().toISOString()} ===`);
log(`budget ${budgetMin}min · max-items ${maxItems || '∞'} · tmdb ${tmdb.hasKey() ? 'on' : 'off'}${mode === 'releases' ? ` · years ${years.join(' + ')}` : ''}${dry ? ' · DRY RUN (nothing is written)' : ''}`);
log(`vault ${vaultData.length} records · state ${Object.keys(state.done).length} tracked urls`);

let azCursor = null;
let backfill = null;
try {
  if (mode === 'releases') await runReleases();
  else if (mode === 'az') azCursor = await runAz();
  else backfill = await runTmdbBackfill();
} catch (error) {
  listingErrors += 1;
  log(`! run aborted: ${error.stack || error.message}`);
}

const tmdbStats = mode === 'tmdb'
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
log(`tmdb           ${backfill
  ? (backfill.needsKey ? 'no key set — nothing done' : `${backfill.filled} filled · ${backfill.misses} no exact match · ${backfill.checked - backfill.filled - backfill.misses} not reached`)
  : tmdbStats.skipped ? 'skipped (no key)' : `${tmdbStats.checked} checked · ${tmdbStats.filled} filled`}`);
log(`http           ${stats.requests} requests · ${stats.retries} retries · ${stats.failures} gave up · ${(stats.bytes / 1e6).toFixed(1)} MB`);
log(`vault          ${vaultData.length} records (${totals.movies} movies · ${totals.series} series) · ${totals.embeds} embeds`);
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

commit(`${mode}: +${counts.added} new, ${counts.merged} merged, ${counts.walked} walks`);

/* A red run means "the site changed shape or is down", not "one item failed". */
const stored = counts.added + counts.merged + counts.unchanged;
if (mode === 'tmdb' && backfill?.needsKey) {
  log('! tmdb mode needs the TMDB_KEYS secret; nothing was changed.');
  process.exitCode = 1;
} else if (counts.walked >= 10 && stored === 0) {
  log(`! ${counts.walked} items were walked and NONE produced embeds — the hop chain or the site changed. Nothing was lost; check the log above.`);
  process.exitCode = 1;
} else if (listingErrors && counts.walked === 0) {
  log('! no listing could be read this run — check the host/reachability.');
  process.exitCode = 1;
}
