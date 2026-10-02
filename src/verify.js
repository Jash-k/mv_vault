#!/usr/bin/env node
/**
 * src/verify.js — offline integrity check for the vault (no network, no deps).
 *
 *   node src/verify.js            # exits 1 if anything is wrong
 *
 * Catches the failure modes that actually bit this repo:
 *   · a record with an empty id (a nav page slugifies to "") — happened;
 *   · a movie that lost its legacy fields, or a series with no episodes;
 *   · series episode counts that disagree with the flat embeds;
 *   · duplicate ids, malformed embed urls, embeds not in the onestream shape;
 *   · stats.json drifting out of sync with vault.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VAULT_FILE, STATE_FILE, STATS_FILE, readStats } from './store.js';
import { INDEX_FILE, MANIFEST_FILE, buildIndex } from './manifest.js';
import { slugify } from './http.js';

const read = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

/**
 * data/known-drift.json — the recorded badness.
 *
 * Before v2.1 the id-drift and shared-embed findings were printed as notes and
 * never enforced, so a regression that introduced NEW drift (a broken slugify,
 * a duplicate-film discovery) passed the gate silently. Now: anything outside
 * the frozen list FAILS. Re-freeze deliberately:
 *
 *   node src/verify.js --update-allowlist
 */
const ALLOWLIST_FILE = path.resolve('data/known-drift.json');
const UPDATE_ALLOWLIST = process.argv.includes('--update-allowlist');
const allowlist = read(ALLOWLIST_FILE, null);

const LEGACY_KEYS = ['id', 'title', 'year', 'pageUrl', 'embeds', 'poster', 'rating', 'tmdbId', 'imdbId'];
const EMBED_RX = /^https:\/\/play\.onestream\.today\/stream\/page\/\d+$/;

const vault = read(VAULT_FILE, []);
const state = read(STATE_FILE, { done: {} });
const stats = readStats();

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const movies = vault.filter((m) => m.kind !== 'series');
const series = vault.filter((m) => m.kind === 'series');

console.log(`\nvault: ${vault.length} records (${movies.length} movies, ${series.length} series)`);
console.log(`state: ${Object.keys(state.done || {}).length} attempted urls\n`);

console.log('RECORDS');
check('vault is a non-empty array', Array.isArray(vault) && vault.length > 0, `${vault.length}`);
const ids = vault.map((m) => m.id);
check('every id is non-empty', ids.every((id) => typeof id === 'string' && id.trim()), `${ids.filter((id) => !id || !id.trim()).length} empty`);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
check('no duplicate ids', dupes.length === 0, dupes.slice(0, 4).join(', '));
// ids are permanent (the app deep-links /vault?play=<id>), so the hard invariant
// is "stable, unique, slug-shaped" — NOT "matches the current title/year". The
// legacy walk built the id from the listing label while `year` was later corrected
// from TMDB, so ~5% of records legitimately disagree (e.g. id `arm-2024`,
// title "ARM", year 1969). Renaming them would break saved links; report instead.
check('every id is a stable slug', vault.every((m) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.id)),
  `${vault.filter((m) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.id)).length} malformed`);
const drifted = vault.filter((m) => m.id !== `${slugify(m.title)}${m.year ? `-${m.year}` : ''}`);
const idDrift = drifted.map((m) => m.id);
if (!allowlist) {
  check('required frozen drift baseline exists', UPDATE_ALLOWLIST);
  console.log(`  note  ${idDrift.length} record(s) carry a legacy id that predates a TMDB year correction`);
  console.log('        (no data/known-drift.json yet — run: node src/verify.js --update-allowlist to freeze them and enable the gate)');
} else {
  const freshDrift = idDrift.filter((id) => !allowlist.idDrift?.includes(id));
  check('id drift is limited to the frozen allowlist', freshDrift.length === 0,
    freshDrift.length ? `${freshDrift.length} NEW: ${freshDrift.slice(0, 5).join(', ')}` : `${idDrift.length} frozen`);
  if (idDrift.length) console.log(`  note  ${idDrift.length} id(s) frozen in data/known-drift.json (legacy ids — see README)`);
}
check('every record carries the app fields', vault.every((m) => LEGACY_KEYS.every((k) => k in m)));
check('titles are latin and not nav junk', vault.every((m) => /[a-z0-9]/i.test(m.title) && !m.title.startsWith('(')));
check('pageUrls are absolute', vault.every((m) => /^https?:\/\//.test(m.pageUrl || '')));

check('year and rating are finite numbers', vault.every(m => Number.isFinite(m.year) && Number.isFinite(m.rating)));
console.log('\nEMBEDS');
const embeds = vault.flatMap((m) => m.embeds || []);
check('every record has at least one embed', vault.every((m) => m.embeds?.length));
check('every embed is a valid onestream url', embeds.every((e) => EMBED_RX.test(e.url || '')),
  `${embeds.filter((e) => !EMBED_RX.test(e.url || '')).length} bad`);
check('every embed has a quality', embeds.every((e) => typeof e.quality === 'string' && e.quality));
// within a record a duplicate would render two identical source chips
const within = vault.filter((m) => {
  const seen = new Set();
  return (m.embeds || []).some((e) => (seen.has(e.url) ? true : (seen.add(e.url), false)));
});
check('no duplicate embed inside a record', within.length === 0, within.map((m) => m.id).join(', '));

// across records it is usually one film stored under two slugs — worth knowing
const byUrl = new Map();
for (const m of vault) for (const e of m.embeds || []) {
  if (!byUrl.has(e.url)) byUrl.set(e.url, new Set());
  byUrl.get(e.url).add(m.id);
}
const shared = [...byUrl.entries()].filter(([, ids]) => ids.size > 1);
const allPairs = new Map();
for (const [, ids] of shared) {
  const key = [...ids].sort().join(' + ');
  allPairs.set(key, (allPairs.get(key) || 0) + 1);
}
if (allPairs.size) {
  const keys = [...allPairs.keys()];
  if (allowlist) {
    const freshPairs = keys.filter((k) => !allowlist.sharedEmbeds?.includes(k));
    check('shared embeds are limited to the frozen allowlist', freshPairs.length === 0,
      freshPairs.length ? `NEW: ${freshPairs.slice(0, 3).join('; ')}` : `${keys.length} frozen`);
  }
  console.log(`  note  ${shared.length} embed url(s) shared between records — probable duplicate films:`);
  for (const [key, count] of allPairs) console.log(`          ${key}  (${count} shared link${count === 1 ? '' : 's'})`);
}

console.log('\nSERIES');
check('every series has seasons', series.every((s) => s.seasons?.length));
const flatMatchesTree = series.every((s) => {
  const tree = s.seasons.flatMap((x) => x.episodes.flatMap((e) => e.embeds.map((b) => b.url))).sort();
  const flat = s.embeds.map((e) => e.url).sort();
  return tree.length === flat.length && tree.every((u, i) => u === flat[i]);
});
check('seasons tree and flat embeds agree (no loss)', flatMatchesTree);
check('every series embed carries season+episode',
  series.every((s) => s.embeds.every((e) => Number(e.season) > 0 && Number(e.episode) > 0)));
const epCount = series.reduce((n, s) => n + s.seasons.reduce((a, x) => a + x.episodes.length, 0), 0);
check('every episode has an embed', series.every((s) => s.seasons.every((x) => x.episodes.every((e) => e.embeds?.length))),
  `${epCount} episodes`);
check('movies are not flagged as series', movies.every((m) => m.kind !== 'series'));

console.log('\nSTATE / STATS');
check('state.done is an object', typeof state.done === 'object' && state.done !== null);
const empties = Object.values(state.done).filter((v) => v?.empty);
// `retries` is optional: entries written before the delta layer existed have none,
// and are treated as attempt 0 so the first retry happens on the next run.
check('retry counters are numeric when present',
  empties.every((v) => v.retries === undefined || Number.isFinite(Number(v.retries))),
  `${empties.length} empty tracked, ${empties.filter((v) => v.retries === undefined).length} awaiting a first retry`);
const stored = vault.filter((m) => m.embeds?.length);
check('stats.totalRecords matches the vault', stats.totalRecords === stored.length, `${stats.totalRecords} vs ${stored.length}`);
check('stats.series matches the vault', stats.series === series.length, `${stats.series} vs ${series.length}`);
check('stats.embedLinks matches the vault', stats.embedLinks === embeds.length, `${stats.embedLinks} vs ${embeds.length}`);
// v2.1: `npm run ingest` used to drop `episodes` from stats without anyone
// noticing, because verify never looked at it. Now it must agree — and so must
// withPoster, the other counter that could drift silently.
check('stats.episodes matches the vault', stats.episodes === epCount, `${stats.episodes} vs ${epCount}`);
const withPoster = vault.filter((m) => m.poster).length;
check('stats.withPoster matches the vault', stats.withPoster === withPoster, `${stats.withPoster} vs ${withPoster}`);
// A page that failed to load repeatedly is marked dead and skipped forever;
// if that number jumps, the site is refusing us, not the catalogue shrinking.
const dead = empties.filter((v) => v.dead);
const partial = Object.values(state.done || {}).filter((v) => v?.partial);
check('retryAfter is well-formed when present',
  empties.every((v) => v.retryAfter === undefined || !Number.isNaN(Date.parse(v.retryAfter))));
if (dead.length) console.log(`  note  ${dead.length} page(s) marked dead after ${dead[0]?.failures || 5}+ unreadable attempts (skipped by the retry queue)`);
if (partial.length) console.log(`  note  ${partial.length} record(s) awaiting a partial re-walk (a hop was unreadable)`);

console.log('\nDERIVED FILES');
const manifest = read(MANIFEST_FILE, null);
const index = read(INDEX_FILE, null);
if (!manifest) {
  check('required manifest exists', false);
  console.log('  note  data/manifest.json missing — run: node scripts/make-manifest.mjs');
} else {
  check('manifest counters match the vault',
    manifest.records === stored.length && manifest.embeds === embeds.length && manifest.series === series.length,
    `${manifest.records}/${manifest.embeds}/${manifest.series}`);
  const rawHash = crypto.createHash('sha256').update(fs.readFileSync(VAULT_FILE)).digest('hex');
  check('manifest sha256 matches vault.json', manifest.sha256 === rawHash, `${String(manifest.sha256).slice(0, 12)}… vs ${rawHash.slice(0, 12)}…`);
  check('browse index content matches vault', JSON.stringify(index) === JSON.stringify(buildIndex(vault)));
  check('browse index covers every record', Array.isArray(index) && index.length === vault.length, `${index?.length} vs ${vault.length}`);
}

console.log(`\nCOVERAGE  ${vault.length} records · ${embeds.length} embeds · ${epCount} episodes · ${empties.length} empty pages tracked · ${partial.length} partial`);

if (UPDATE_ALLOWLIST) {
  const payload = {
    _note: 'Frozen at the last deliberate review. Anything NOT listed here fails verify.js. Re-freeze with: node src/verify.js --update-allowlist',
    frozenAt: new Date().toISOString(),
    idDrift: [...idDrift].sort(),
    sharedEmbeds: [...allPairs.keys()].sort(),
  };
  fs.writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`allowlist  wrote ${ALLOWLIST_FILE} (${idDrift.length} id drift, ${allPairs.size} shared embed group)`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
