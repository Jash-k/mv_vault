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
import { VAULT_FILE, STATE_FILE, STATS_FILE, readStats } from './store.js';
import { slugify } from './http.js';

const read = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

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
const idDrift = vault.filter((m) => m.id !== `${slugify(m.title)}${m.year ? `-${m.year}` : ''}`);
if (idDrift.length) {
  console.log(`  note  ${idDrift.length} record(s) carry a legacy id that predates a TMDB year correction`);
  idDrift.slice(0, 3).forEach((m) => console.log(`          id=${m.id}  title="${m.title}"  year=${m.year}`));
}
check('every record carries the app fields', vault.every((m) => LEGACY_KEYS.every((k) => k in m)));
check('titles are latin and not nav junk', vault.every((m) => /[a-z0-9]/i.test(m.title) && !m.title.startsWith('(')));
check('pageUrls are absolute', vault.every((m) => /^https?:\/\//.test(m.pageUrl || '')));

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
if (shared.length) {
  const pairs = new Map();
  for (const [, ids] of shared) {
    const key = [...ids].sort().join(' + ');
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
  console.log(`  note  ${shared.length} embed url(s) shared between records — probable duplicate films:`);
  for (const [key, count] of pairs) console.log(`          ${key}  (${count} shared link${count === 1 ? '' : 's'})`);
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

console.log(`\nCOVERAGE  ${vault.length} records · ${embeds.length} embeds · ${epCount} episodes · ${empties.length} empty pages tracked`);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
