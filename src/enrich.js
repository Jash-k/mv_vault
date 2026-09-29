#!/usr/bin/env node
/**
 * src/enrich.js — backfill TMDB metadata (poster / rating / imdbId) on vault records.
 *
 *   TMDB_KEYS=k1,k2 node src/enrich.js [--limit=200] [--concurrency=4] [--dry]
 *
 * Two kinds of work, both resumable — just run it again until it reports 0:
 *
 *   search  records with no tmdbId  → search by title (+year), guarded match
 *   repair  records WITH a tmdbId but no poster → fetch that exact id (no search)
 *
 * A record is only ever written when TMDB returned something for it, so an
 * expired key pool or a transient outage leaves data exactly as it was. Writes
 * are atomic (temp file + rename) and happen every 25 fills, so a killed run
 * keeps its progress.
 *
 * Titles it could not match are written to data/enrich-unmatched.json — that
 * file is the honest to-do list for anything that needs a manual tmdbId.
 */
import fs from 'node:fs';
import path from 'node:path';
import { enrichWithTmdb, movieDetails, keyCount } from './tmdb.js';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DATA = path.resolve('data');
const VAULT_FILE = path.join(DATA, 'vault.json');
const REPORT_FILE = arg('report', path.join(DATA, 'enrich-unmatched.json'));
const CONCURRENCY = Number(arg('concurrency', 4)) || 4;
const LIMIT = Number(arg('limit', 0)) || 0;
const DRY = has('dry');

if (!keyCount()) {
  console.error('[enrich] no TMDB_KEYS set — nothing to do.\n         TMDB_KEYS=k1,k2 node src/enrich.js');
  process.exit(1);
}

const vault = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
const needSearch = vault.filter((m) => !m.tmdbId);
const needRepair = vault.filter((m) => m.tmdbId && !m.poster);
const work = [
  ...needSearch.map((record) => ({ record, mode: 'search' })),
  ...needRepair.map((record) => ({ record, mode: 'repair' })),
];
const batch = LIMIT ? work.slice(0, LIMIT) : work;

console.log(`[enrich] TMDB keys: ${keyCount()} | missing tmdbId: ${needSearch.length} | matched but poster-less: ${needRepair.length} | this run: ${batch.length}${DRY ? ' (dry)' : ''}`);
if (!batch.length) {
  console.log('[enrich] nothing left to do — every record has been matched at least once.');
  process.exit(0);
}

let filled = 0; let unmatched = 0; let i = 0; const failures = [];

const write = () => {
  if (DRY) return;
  fs.writeFileSync(`${VAULT_FILE}.tmp`, JSON.stringify(vault, null, 1));
  fs.renameSync(`${VAULT_FILE}.tmp`, VAULT_FILE);
};

const apply = (record, meta) => {
  let changed = false;
  if (meta.poster && meta.poster !== record.poster) { record.poster = meta.poster; changed = true; }
  if (meta.rating && meta.rating !== record.rating) { record.rating = meta.rating; changed = true; }
  if (meta.tmdbId && meta.tmdbId !== record.tmdbId) { record.tmdbId = meta.tmdbId; changed = true; }
  if (meta.imdbId && meta.imdbId !== record.imdbId) { record.imdbId = meta.imdbId; changed = true; }
  if (!record.year && meta.year) { record.year = meta.year; changed = true; }
  return changed;
};

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
  while (i < batch.length) {
    const { record, mode } = batch[i++];
    let meta = null;
    try {
      meta = mode === 'repair'
        ? await movieDetails(record.tmdbId)
        : await enrichWithTmdb({ title: record.title, year: record.year });
    } catch { meta = null; }

    if (!meta?.tmdbId) {
      unmatched += 1;
      failures.push({
        id: record.id,
        title: record.title,
        year: record.year || 0,
        reason: mode === 'search' ? 'no guarded TMDB match (title/year)' : 'TMDB id returned nothing',
        tmdbId: record.tmdbId || 0,
      });
      continue;
    }
    if (apply(record, meta)) filled += 1;
    else if (mode === 'repair') {
      // matched, but TMDB has no poster for this film — nothing to write, and it
      // will keep coming back, so record it as an open item instead of hiding it
      failures.push({ id: record.id, title: record.title, year: record.year || 0, reason: 'TMDB has no poster for this title', tmdbId: record.tmdbId });
    }
    if (filled && filled % 25 === 0) { write(); console.log(`  … ${filled} filled`); }
  }
}));

write();

if (!DRY) {
  failures.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  fs.writeFileSync(REPORT_FILE, JSON.stringify({
    _note: 'Titles TMDB could not match, or matched without a poster. Fix by adding the tmdbId by hand, or leave them poster-less — nothing else depends on it.',
    generatedAt: new Date().toISOString(),
    count: failures.length,
    entries: failures,
  }, null, 1));

  const statsFile = path.join(DATA, 'vault-stats.json');
  try {
    const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    const withEmbeds = vault.filter((m) => m.embeds?.length);
    fs.writeFileSync(statsFile, JSON.stringify({
      ...stats,
      updatedAt: new Date().toISOString(),
      withPoster: withEmbeds.filter((m) => m.poster).length,
      withoutPoster: withEmbeds.filter((m) => !m.poster).length,
    }, null, 1));
  } catch { /* stats optional */ }
}

const posters = vault.filter((m) => m.embeds?.length && m.poster).length;
console.log(`[enrich] filled=${filled} unmatched=${unmatched}${DRY ? '  (dry: nothing written)' : ''}`);
console.log(`[enrich] records with a poster: ${posters} / ${vault.length}${failures.length && !DRY ? `  ·  unmatchable listed in ${path.relative(process.cwd(), REPORT_FILE)}` : ''}`);
for (const row of failures.slice(0, 10)) console.log(`  – ${row.title} (${row.year || '—'}) — ${row.reason}`);
if (failures.length > 10) console.log(`  … ${failures.length - 10} more in the report file`);
