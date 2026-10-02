/**
 * src/manifest.js — the two derived files consumers actually want.
 *
 * data/manifest.json (~0.4 KB) answers "has anything changed?" without pulling
 * the 1.83 MB catalogue: it carries the record/embed counters, when the last
 * NEW record landed (`lastAddedAt` — the freshness signal the watchdog uses)
 * and a sha256 the app can use as an ETag.
 *
 * data/index.json is the browse index — id, title, year, kind, rating, poster
 * — so a list/rail view never downloads embed URLs (379 KB → 107 KB gzip).
 * Full records stay in vault.json and are fetched per item on open.
 *
 * Written by `saveAll()` (so every checkpoint refreshes them) and by
 * `node scripts/make-manifest.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
export const VAULT_FILE = path.join(DATA_DIR, 'vault.json');
export const INDEX_FILE = path.join(DATA_DIR, 'index.json');
export const MANIFEST_FILE = path.join(DATA_DIR, 'manifest.json');

/** Browse index: short keys, because every client downloads this. */
export function buildIndex(vault) {
  return vault.map((m) => ({
    i: m.id,
    t: m.title,
    y: m.year || 0,
    k: m.kind === 'series' ? 's' : 'm',
    r: m.rating || 0,
    p: m.poster || '',
  }));
}

export function buildManifest(vault, stats, bytes = Buffer.alloc(0)) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    vaultUpdatedAt: stats.updatedAt,
    lastAddedAt: stats.lastAddedAt || '',
    records: vault.length,
    movies: stats.movies,
    series: stats.series,
    episodes: stats.episodes,
    embeds: stats.embedLinks,
    emptyPages: stats.emptyPages ?? 0,
    partialPages: stats.partialPages ?? 0,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    vault: 'vault.json',
    index: 'index.json',
  };
}

export function writeDerived(vault, stats, { quiet = true } = {}) {
  const bytes = fs.readFileSync(VAULT_FILE);
  const manifest = buildManifest(vault, stats, bytes);
  fs.writeFileSync(`${INDEX_FILE}.tmp`, `${JSON.stringify(buildIndex(vault))}\n`);
  fs.renameSync(`${INDEX_FILE}.tmp`, INDEX_FILE);
  fs.writeFileSync(`${MANIFEST_FILE}.tmp`, `${JSON.stringify(manifest, null, 1)}\n`);
  fs.renameSync(`${MANIFEST_FILE}.tmp`, MANIFEST_FILE);
  if (!quiet) {
    const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
    console.log(`[manifest] index ${kb(fs.statSync(INDEX_FILE).size)} · sha256 ${manifest.sha256.slice(0, 12)}… · last added ${manifest.lastAddedAt || '—'}`);
  }
  return manifest;
}
