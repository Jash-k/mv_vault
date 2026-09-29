#!/usr/bin/env node
/**
 * src/ingest.js — ingest a verified queue of new titles into the vault.
 *
 *   node src/ingest.js --queue=data/incoming.json [--concurrency=6] [--dry]
 *                      [--checkpoint=25] [--limit=N]
 *
 * Why this exists: the historic walk (src/cli.js) only ever discovers items under
 * /tamil-movies/<letter>/, so web series, numeric-titled films, the 2015–17
 * back-catalogue and the dubbed section were never visited. This ingests a queue
 * produced by a full section sweep (see data/incoming.json).
 *
 * Guarantees:
 *  - existing vault records are NEVER rewritten (only appended to, or merged when
 *    the same id arrives twice)
 *  - a record is only added when at least one live embed was confirmed
 *  - writes are atomic (tmp + rename) and checkpointed, so a kill loses nothing
 *  - `--dry` walks and reports without touching data/
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWalk, walkItem } from './walk.js';
import { slugify } from './http.js';
import { normalizeEntry } from './titles.js';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DATA = path.resolve('data');
const VAULT_FILE = path.join(DATA, 'vault.json');
const STATE_FILE = path.join(DATA, 'state.json');
const STATS_FILE = path.join(DATA, 'vault-stats.json');

const QUEUE = arg('queue', 'data/incoming.json');
const CONCURRENCY = Number(arg('concurrency', 6));
const CHECKPOINT = Number(arg('checkpoint', 25));
const LIMIT = Number(arg('limit', 0)) || 0;
const DRY = has('dry');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
/** Atomic write: never leave a half-written catalog behind. */
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

const queue = readJson(QUEUE, null);
if (!Array.isArray(queue) || !queue.length) {
  console.error(`[ingest] no queue at ${QUEUE} (expected a JSON array of {url,title,year,kind})`);
  process.exit(1);
}
const work = LIMIT ? queue.slice(0, LIMIT) : queue;

const vault = readJson(VAULT_FILE, []);
const state = readJson(STATE_FILE, { done: {}, letters: {} });
state.done = state.done || {};

const byId = new Map(vault.map((m, i) => [m.id, i]));

console.log(`[ingest] queue=${work.length} (of ${queue.length}) concurrency=${CONCURRENCY} dry=${DRY}`);
console.log(`[ingest] vault before: ${vault.length} records`);

const makeId = (title, year) => `${slugify(title)}${year ? `-${year}` : ''}`;

/** Merge embeds into an existing record without clobbering anything. */
function mergeInto(record, fresh) {
  const have = new Set((record.embeds || []).map((e) => e.url));
  for (const e of fresh) {
    if (have.has(e.url)) continue;
    have.add(e.url);
    (record.embeds ||= []).push(e);
  }
  record.updatedAt = new Date().toISOString();
}

function toRecord(entry, walked) {
  const { title, year } = entry;
  const id = makeId(title, year);
  const record = {
    id,
    title,
    year: year || 0,
    kind: walked.kind,
    pageUrl: entry.url,
    embeds: [],
    poster: '',
    rating: 0,
    tmdbId: 0,
    imdbId: '',
    addedAt: new Date().toISOString(),
  };
  if (walked.kind === 'series') {
    record.seasons = walked.seasons;
    record.embeds = walked.seasons.flatMap((s) =>
      s.episodes.flatMap((ep) => ep.embeds.map((e) => ({ ...e, season: s.season, episode: ep.episode }))));
    if (!record.seasons.length) return null;
  } else {
    record.embeds = walked.embeds;
  }
  return record.embeds.length ? record : null;
}

const walk = createWalk({ concurrency: CONCURRENCY });
const stats = { added: 0, merged: 0, empty: 0, failed: 0, rejected: 0, embeds: 0, series: 0 };
const failures = [];
const started = Date.now();
let sinceCheckpoint = 0;

function checkpoint() {
  if (DRY) return;
  writeJson(VAULT_FILE, vault);
  writeJson(STATE_FILE, state);
  sinceCheckpoint = 0;
}

const mapLimit = async (arr, k, fn) => {
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(k, arr.length) }, async () => {
    while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx], idx); }
  }));
  return out;
};

await mapLimit(work, CONCURRENCY, async (rawEntry, idx) => {
  // Title hygiene + hard rejection of non-items (a section heading slugs to an
  // empty id and must never reach the catalog).
  const norm = normalizeEntry(rawEntry);
  if (norm.rejected) {
    stats.rejected += 1;
    console.log(`  x skipped (${norm.rejected}): ${rawEntry.path || rawEntry.url}`);
    return;
  }
  const entry = { ...rawEntry, title: norm.title, year: norm.year };
  const { title, year } = entry;
  const where = entry.kind === 'series' ? 'series' : 'movie';
  let walked;
  try {
    walked = await walkItem(entry.url, { walk });
  } catch (error) {
    stats.failed += 1;
    failures.push(`${entry.url} — ${error.message}`);
    console.warn(`  ! ${title}: ${error.message}`);
    return;
  }

  const record = toRecord(entry, walked);
  if (record && !record.id) {
    stats.rejected += 1;
    console.warn(`  x refused: empty id for ${entry.url}`);
    return;
  }
  if (!record) {
    stats.empty += 1;
    console.log(`  – ${title} (${year || '—'})  ${where}: no live embeds`);
    // remember the attempt so the walk does not repeat it blindly
    if (!DRY) state.done[entry.url] = { at: new Date().toISOString(), empty: true };
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= CHECKPOINT) checkpoint();
    return;
  }

  const existingIdx = byId.get(record.id);
  if (existingIdx !== undefined) {
    mergeInto(vault[existingIdx], record.embeds);
    stats.merged += 1;
    console.log(`  ~ ${title} (${year || '—'})  merged into existing ${record.id}`);
  } else {
    vault.push(record);
    byId.set(record.id, vault.length - 1);
    stats.added += 1;
    if (record.kind === 'series') stats.series += 1;
    const eps = record.seasons
      ? record.seasons.reduce((n, s) => n + s.episodes.length, 0)
      : 0;
    console.log(`  + ${title} (${year || '—'})  ${record.kind}: ${record.embeds.length} embeds${eps ? ` across ${eps} episodes` : ''}`);
  }
  stats.embeds += record.embeds.length;
  if (!DRY) state.done[entry.url] = { at: new Date().toISOString(), embeds: record.embeds.length, kind: record.kind };

  sinceCheckpoint += 1;
  if (sinceCheckpoint >= CHECKPOINT) {
    checkpoint();
    console.log(`  … checkpoint (${idx + 1}/${work.length})`);
  }
});

if (!DRY) {
  // ---- vault-stats.json (keep the existing shape, add the kind breakdown) ----
  const withEmbeds = vault.filter((m) => m.embeds?.length);
  const prev = readJson(STATS_FILE, {});
  writeJson(VAULT_FILE, vault);
  writeJson(STATE_FILE, state);
  writeJson(STATS_FILE, {
    updatedAt: new Date().toISOString(),
    processed: Object.keys(state.done || {}).length,
    movies: withEmbeds.filter((m) => (m.kind || 'movie') !== 'series').length,
    series: withEmbeds.filter((m) => m.kind === 'series').length,
    totalRecords: withEmbeds.length,
    embedLinks: withEmbeds.reduce((n, m) => n + (m.embeds?.length || 0), 0),
    withPoster: withEmbeds.filter((m) => m.poster).length,
    letters: state.letters || prev.letters || {},
  });
}

console.log('\n[ingest] SUMMARY', JSON.stringify({
  ...stats,
  vaultAfter: vault.length,
  requests: walk.stats.reqs,
  mb: Number((walk.stats.bytes / 1048576).toFixed(2)),
  seconds: Math.round((Date.now() - started) / 1000),
}, null, 0));
if (failures.length) {
  console.log(`[ingest] ${failures.length} failures:`);
  failures.slice(0, 20).forEach((f) => console.log('   ', f));
}
if (DRY) console.log('[ingest] --dry: no files written');
