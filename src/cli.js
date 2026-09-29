#!/usr/bin/env node
/**
 * moviesda-vault CLI v2 — discovery + fast walk.
 *
 * Modes
 *   --letters=a-c            historic A–Z letter walk      (fast walker)
 *   --incremental            NEW ARRIVALS: sitemap.xml + /tamil-latest-updates/
 *                            + items whose retry window has opened  (2 requests)
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
 *
 * Env: TMDB_KEYS=k1,k2,k3 · VAULT_BUDGET_MIN · VAULT_MAX_MOVIES
 *
 * Performance: this uses src/walk.js — a planned, memoised, cross-item pipelined
 * walk (1.2 s/item measured vs 24.8 s/item for the original sequential chain, with
 * identical embed output; see CHANGES.md).
 */
import { listLetter } from './scraper.js';
import { createWalk, walkItem } from './walk.js';
import { discover, loadAliases } from './delta.js';
import { cleanTitle, isRejected } from './titles.js';
import { enrichWithTmdb, keyCount } from './tmdb.js';
import { loadData, saveAll, upsertRecord, recordFromWalk, recordKind, markDone, markEmpty } from './store.js';
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
const CHECKPOINT_EVERY = Number(arg('checkpoint', 25)) || 25;
/** Alternate URLs for titles already stored — never ingested (see data/aliases.json). */
const ALIASES = loadAliases(new URL('../data/aliases.json', import.meta.url));

const MODE = SINGLE_ITEM ? 'item'
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

console.log(`[vault] mode=${MODE} concurrency=${CONCURRENCY} maxMovies=${MAX_MOVIES} budget=${Math.round(BUDGET_MS / 60000)}min${DRY ? ' DRY RUN' : ''}`);
console.log(`[vault] tmdb keys loaded: ${keyCount()}`);

const { state, vault } = loadData();
const walk = createWalk({ concurrency: CONCURRENCY });

const counts = { added: 0, merged: 0, unchanged: 0, empty: 0, failed: 0, skipped: 0, embeds: 0, series: 0 };
let sinceCheckpoint = 0;

function checkpoint(force = false) {
  if (DRY) return;
  if (!force && sinceCheckpoint < CHECKPOINT_EVERY) return;
  saveAll({ state, vault });
  sinceCheckpoint = 0;
}

/** Title + year for a discovered item: listings carry a label, feeds only a path. */
function titleFor(entry) {
  const fromLabel = entry.label ? parseTitleYear(entry.label) : { title: '', year: 0 };
  const cleaned = cleanTitle(fromLabel.title || entry.title || '', entry.path);
  return { title: cleaned.title || fromLabel.title, year: cleaned.year || fromLabel.year || 0 };
}

/** Turn a discovered row into a walkable queue entry, or reject it. */
function toQueueEntry(entry) {
  const { title, year } = titleFor(entry);
  if (ALIASES.includes(entry.path)) { counts.skipped += 1; return null; } // alias of a stored title
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
    maxPages: MAX_PAGES,
    onProgress: MODE === 'sweep'
      ? (target, count, total) => console.log(
        `  ${target.section.label} ${target.key}: ${count} items${target.section.index ? ' (index page — 0 expected)' : ''} (running total ${total})`)
      : null,
  });

  console.log(`[vault] known paths=${result.known}  sources=${JSON.stringify(result.sources)}`);
  if (result.skippedAliases) console.log(`[vault] alias URLs excluded=${result.skippedAliases} (data/aliases.json)`);
  console.log(`[vault] new arrivals=${result.fresh.length}  due-retries=${result.retries.length}`);
  for (const entry of result.queue) push(entry);
  return queue;
}

/** Walk one item and merge it into the vault. */
async function processEntry(entry) {
  const walked = await walkItem(entry.url, { walk });
  const record = recordFromWalk(entry, walked, { id: entry.id });
  const kind = recordKind(record || { kind: entry.kind, seasons: walked.seasons });

  if (!record) {
    counts.empty += 1;
    console.log(`  – ${entry.title || entry.path}  ${kind}: no live embeds`);
    if (!DRY) markEmpty(state, entry.url, { kind });
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
  console.log(`  ${tag} ${record.title} (${record.year || '—'}) ${kind}: ${record.embeds.length} embeds${episodes ? ` / ${episodes} episodes` : ''}`);

  if (!DRY) markDone(state, entry.url, { embeds: record.embeds.length, kind });
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

try {
  const queue = await buildQueue();

  // two URLs can describe one film (alternate slugs) — keep the first, by id
  const byId = new Map();
  for (const entry of queue) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  const deduped = [...byId.values()];
  if (deduped.length !== queue.length) console.log(`[vault] de-duplicated ${queue.length - deduped.length} duplicate id(s)`);

  const run = MAX_MOVIES ? deduped.slice(0, MAX_MOVIES) : deduped;
  if (run.length < deduped.length) console.log(`[vault] capping this run at ${run.length} of ${deduped.length} items`);
  console.log(`[vault] walking ${run.length} item(s) …`);

  await mapLimit(run, CONCURRENCY, async (entry) => {
    if (Date.now() > deadline) return;
    try {
      await processEntry(entry);
    } catch (error) {
      counts.failed += 1;
      console.warn(`  ! ${entry.title || entry.path}: ${error.message}`);
    }
  });

  if (Date.now() > deadline) console.log('[vault] budget reached — stopped gracefully (state is checkpointed, re-run resumes)');
  await enrichNew(run);
} finally {
  checkpoint(true);
  const withEmbeds = vault.filter((m) => m.embeds?.length);
  console.log('[vault] RUN SUMMARY', JSON.stringify({
    mode: MODE,
    added: counts.added,
    merged: counts.merged,
    unchanged: counts.unchanged,
    empty: counts.empty,
    skipped: counts.skipped,
    failed: counts.failed,
    newSeries: counts.series,
    embedsAdded: counts.embeds,
    vaultTotal: withEmbeds.length,
    vaultEmbeds: withEmbeds.reduce((n, m) => n + m.embeds.length, 0),
    requests: walk.stats.reqs,
    mb: Number((walk.stats.bytes / 1048576).toFixed(2)),
    minutes: Math.round((Date.now() - started) / 60000),
    ...(DRY ? { dry: true } : {}),
  }));
  if (DRY) console.log('[vault] --dry: nothing written');
}
