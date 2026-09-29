/**
 * Vault state + output.
 *
 * data/state.json       — resume + delta state. One entry per attempted item URL:
 *                         { at, embeds } for a hit, { at, empty:true, retries:n }
 *                         for a page that yielded nothing (re-tried on a widening
 *                         schedule — see delta.js).
 * data/vault.json       — THE deliverable: [{ id, title, year, kind, pageUrl,
 *                         embeds, poster, rating, tmdbId, imdbId, seasons? }]
 * data/vault-stats.json — human-readable counters.
 *
 * Two deliberate changes from the original:
 *   · every write is ATOMIC (tmp + rename), so a kill mid-write can never leave
 *     a half-serialised 1.7 MB catalogue behind;
 *   · state is NO LONGER pruned. The old code kept only the newest 15,000 keys
 *     and silently dropped the oldest — which are precisely the items least
 *     likely to be re-verified, and whose loss would send the walker back over
 *     ground it had already covered.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve('data');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const VAULT_FILE = path.join(DATA_DIR, 'vault.json');
export const STATS_FILE = path.join(DATA_DIR, 'vault-stats.json');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

/** Write JSON atomically: a reader sees either the old file or the new one. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

export function loadData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const state = readJson(STATE_FILE, { done: {}, letters: {} });
  state.done = state.done || {};
  state.letters = state.letters || {};
  const vault = readJson(VAULT_FILE, []);
  return { state, vault: Array.isArray(vault) ? vault : [] };
}

export function buildStats(vault = [], state = {}) {
  const stored = vault.filter((m) => m.embeds?.length);
  const series = stored.filter((m) => m.kind === 'series');
  return {
    updatedAt: new Date().toISOString(),
    processed: Object.keys(state.done || {}).length,
    movies: stored.length - series.length,
    series: series.length,
    totalRecords: stored.length,
    episodes: series.reduce((n, m) => n + (m.seasons || []).reduce((a, s) => a + s.episodes.length, 0), 0),
    embedLinks: stored.reduce((n, m) => n + m.embeds.length, 0),
    withPoster: stored.filter((m) => m.poster).length,
    letters: state.letters || {},
  };
}

/** Persist vault + state + stats in one pass. */
export function saveAll({ state, vault }) {
  writeJson(VAULT_FILE, vault);
  writeJson(STATE_FILE, state);
  const stats = buildStats(vault, state);
  writeJson(STATS_FILE, stats);
  return stats;
}

export function saveStats(state, vault) {
  const stats = buildStats(vault, state);
  writeJson(STATS_FILE, stats);
  return stats;
}

const mergeEmbeds = (existing = [], fresh = []) => {
  const seen = new Set(existing.map((e) => e.url));
  const out = existing.slice();
  for (const embed of fresh) {
    if (!embed?.url || seen.has(embed.url)) continue;
    seen.add(embed.url);
    out.push(embed);
  }
  return out;
};

/** Season/episode-aware merge: union of episodes, union of qualities within each. */
const mergeSeasons = (existing = [], fresh = []) => {
  const bySeason = new Map(existing.map((s) => [Number(s.season), {
    season: Number(s.season),
    episodes: new Map((s.episodes || []).map((e) => [Number(e.episode), { episode: Number(e.episode), embeds: (e.embeds || []).slice() }])),
  }]));
  for (const season of fresh) {
    const key = Number(season.season);
    if (!bySeason.has(key)) {
      bySeason.set(key, {
        season: key,
        episodes: new Map((season.episodes || []).map((e) => [Number(e.episode), { episode: Number(e.episode), embeds: (e.embeds || []).slice() }])),
      });
      continue;
    }
    const target = bySeason.get(key);
    for (const episode of season.episodes || []) {
      const epKey = Number(episode.episode);
      if (!target.episodes.has(epKey)) {
        target.episodes.set(epKey, { episode: epKey, embeds: (episode.embeds || []).slice() });
        continue;
      }
      const target2 = target.episodes.get(epKey);
      target2.embeds = mergeEmbeds(target2.embeds, episode.embeds || []);
    }
  }
  return [...bySeason.values()]
    .sort((a, b) => a.season - b.season)
    .map((s) => ({ season: s.season, episodes: [...s.episodes.values()].sort((a, b) => a.episode - b.episode) }));
};

/**
 * Merge one walked item into the vault.
 *
 * Fresh embeds are ADDED, never substituted: if the site temporarily drops a
 * quality, the vault keeps the link it already proved live. Returns
 * { action: 'added' | 'merged' | 'unchanged', record }.
 */
export function upsertRecord(vault, record) {
  if (!record?.id || !record.embeds?.length) return { action: 'unchanged', record: null };
  const index = vault.findIndex((m) => m.id === record.id);

  if (index < 0) {
    const created = { ...record, addedAt: record.addedAt || new Date().toISOString() };
    vault.push(created);
    return { action: 'added', record: created };
  }

  const existing = vault[index];
  const before = JSON.stringify(existing.embeds);
  existing.embeds = mergeEmbeds(existing.embeds, record.embeds);
  if (record.kind === 'series' || record.seasons?.length) {
    existing.kind = 'series';
    existing.seasons = mergeSeasons(existing.seasons, record.seasons || []);
  }
  // fill metadata gaps without ever downgrading what is already there
  for (const key of ['poster', 'imdbId']) if (!existing[key] && record[key]) existing[key] = record[key];
  for (const key of ['rating', 'tmdbId']) if (!existing[key] && record[key]) existing[key] = record[key];
  if (!existing.year && record.year) existing.year = record.year;

  const changed = before !== JSON.stringify(existing.embeds);
  if (changed) existing.updatedAt = new Date().toISOString();
  return { action: changed ? 'merged' : 'unchanged', record: existing };
}

/** Record an attempt so the delta layer knows about it. */
export function markDone(state, url, payload) {
  state.done[url] = { at: new Date().toISOString(), ...payload };
}

/** Record a page that yielded nothing, with its retry counter advanced. */
export function markEmpty(state, url, { kind } = {}) {
  const previous = state.done[url] || {};
  state.done[url] = {
    at: new Date().toISOString(),
    empty: true,
    retries: Number(previous.retries || 0) + 1,
    ...(kind ? { kind } : {}),
  };
  return state.done[url];
}

/** Legacy helper kept for compatibility. */
export function upsertMovie(vault, movie) {
  return upsertRecord(vault, movie).action === 'added';
}

/** Build a vault record from a discovery entry + a walked result. */
/**
 * Build a persisted record. Two hard rules from the shipped data:
 *  - a movie record carries NO `kind` key (2,700 of the legacy records do not;
 *    "kind absent ⇒ movie" is the app's contract, and every extra key costs
 *    bytes across thousands of records),
 *  - key order follows the legacy records exactly, so a re-written vault file
 *    diffs cleanly.
 * `kind` is therefore returned out-of-band via `recordKind()`.
 */
export function recordKind(record) {
  return record?.kind === 'series' || record?.seasons?.length ? 'series' : 'movie';
}

export function recordFromWalk(entry, walked, { id }) {
  const isSeries = walked.kind === 'series';
  const record = {
    id,
    title: entry.title,
    year: entry.year || 0,
    ...(isSeries ? { kind: 'series' } : {}),
    pageUrl: entry.url,
    embeds: [],
    poster: '',
    rating: 0,
    tmdbId: 0,
    imdbId: '',
    addedAt: new Date().toISOString(),
  };
  if (isSeries) {
    record.seasons = walked.seasons || [];
    record.embeds = record.seasons.flatMap((s) =>
      s.episodes.flatMap((ep) => ep.embeds.map((e) => ({ ...e, season: s.season, episode: ep.episode }))));
    if (!record.seasons.length) return null;
  } else {
    record.embeds = walked.embeds || [];
  }
  return record.embeds.length ? record : null;
}

export const readStats = () => readJson(STATS_FILE, {});
