#!/usr/bin/env node
/**
 * src/enrich.js — backfill TMDB metadata (poster/rating/imdbId) on vault records.
 *
 *   TMDB_KEYS=k1,k2 node src/enrich.js [--limit=200] [--concurrency=4] [--dry]
 *
 * Records written by `src/ingest.js` carry placeholder metadata
 * (poster:"", rating:0, tmdbId:0, imdbId:"") so the catalog shape stays uniform.
 * Run this once with your key pool to fill them in — it reuses the same
 * key-rotating client as the historic scrape (src/tmdb.js).
 *
 * Safe by construction: a record is only touched when a TMDB match is found,
 * so an expired key pool or a transient outage leaves data exactly as it was.
 */
import fs from 'node:fs';
import path from 'node:path';
import { enrichWithTmdb, keyCount } from './tmdb.js';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DATA = path.resolve('data');
const VAULT_FILE = path.join(DATA, 'vault.json');
const CONCURRENCY = Number(arg('concurrency', 4));
const LIMIT = Number(arg('limit', 0)) || 0;
const DRY = has('dry');

if (!keyCount()) {
  console.error('[enrich] no TMDB_KEYS set — nothing to do.\n         TMDB_KEYS=k1,k2 node src/enrich.js');
  process.exit(1);
}

const vault = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
const missing = vault.filter((m) => !m.tmdbId);
const work = LIMIT ? missing.slice(0, LIMIT) : missing;
console.log(`[enrich] TMDB keys: ${keyCount()} | records without tmdbId: ${missing.length} | this run: ${work.length}${DRY ? ' (dry)' : ''}`);

let filled = 0, missed = 0, i = 0;
const write = () => {
  if (DRY) return;
  fs.writeFileSync(`${VAULT_FILE}.tmp`, JSON.stringify(vault, null, 1));
  fs.renameSync(`${VAULT_FILE}.tmp`, VAULT_FILE);
};

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
  while (i < work.length) {
    const idx = i++;
    const record = work[idx];
    let meta;
    try {
      meta = await enrichWithTmdb({ title: record.title, year: record.year });
    } catch {
      missed += 1;
      continue;
    }
    if (!meta?.tmdbId) { missed += 1; continue; }
    if (!DRY) {
      record.poster = meta.poster || record.poster || '';
      record.rating = meta.rating || record.rating || 0;
      record.tmdbId = meta.tmdbId;
      record.imdbId = meta.imdbId || record.imdbId || '';
      if (!record.year && meta.year) record.year = meta.year;
    }
    filled += 1;
    if (filled % 25 === 0) { write(); console.log(`  … ${filled} filled`); }
  }
}));

write();
// stats stay in sync with the poster count
const statsFile = path.join(DATA, 'vault-stats.json');
try {
  const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  const withEmbeds = vault.filter((m) => m.embeds?.length);
  fs.writeFileSync(statsFile, JSON.stringify({
    ...stats,
    updatedAt: new Date().toISOString(),
    withPoster: withEmbeds.filter((m) => m.poster).length,
  }, null, 1));
} catch { /* stats optional */ }

console.log(`[enrich] filled=${filled} unmatched=${missed}${DRY ? '  (dry: nothing written)' : ''}`);
