/**
 * Vault state + output builder.
 *
 * data/state.json   — resumable progress: every item URL already processed
 *                     (succeeded or permanently empty), plus run metadata.
 * data/vault.json   — THE deliverable: [{ id, title, year, pageUrl, embeds[],
 *                     poster, rating, tmdbId, imdbId }] (movies WITH embeds)
 * data/vault-stats.json — human-readable counters for the README/dashboard.
 *
 * The catalog entry keeps the stable pageUrl too, so even if an onestream ID
 * dies someday, a fresh walk can still run from it.
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve('data');
const STATE_FILE = path.join(DATA, 'state.json');
const VAULT_FILE = path.join(DATA, 'vault.json');
const STATS_FILE = path.join(DATA, 'vault-stats.json');

export function loadData() {
  fs.mkdirSync(DATA, { recursive: true });
  const state = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { done: {}, movies: {} };
  const vault = fs.existsSync(VAULT_FILE)
    ? JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'))
    : [];
  return { state, vault };
}

export function saveData({ state, vault }) {
  fs.mkdirSync(DATA, { recursive: true });
  // Keep state bounded — it only stores URLs, but old entries are cheap to drop.
  const doneKeys = Object.keys(state.done || {});
  if (doneKeys.length > 20000) {
    const keep = new Set(doneKeys.slice(-15000));
    for (const key of doneKeys) {
      if (!keep.has(key)) delete state.done[key];
    }
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  fs.writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 1));
  const withEmbeds = vault.filter((m) => m.embeds?.length);
  const totalEmbeds = vault.reduce((n, m) => n + (m.embeds?.length || 0), 0);
  fs.writeFileSync(
    STATS_FILE,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        processed: Object.keys(state.done || {}).length,
        movies: withEmbeds.length,
        embedLinks: totalEmbeds,
        withPoster: vault.filter((m) => m.poster).length,
        letters: state.letters || {},
      },
      null,
      1,
    ),
  );
}

/** Merge one scraped movie into the vault (fresh embeds win, ids stable). */
export function upsertMovie(vault, movie) {
  if (!movie.embeds?.length) return false;
  const existing = vault.findIndex((m) => m.id === movie.id);
  if (existing >= 0) {
    vault[existing] = { ...movie, addedAt: vault[existing].addedAt, updatedAt: new Date().toISOString() };
  } else {
    vault.push({ ...movie, addedAt: new Date().toISOString() });
  }
  return true;
}
