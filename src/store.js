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
import { nextRetryAt, nextFailureAt, MAX_FAILURES } from './schedule.js';
import { writeDerived } from './manifest.js';

export const DATA_DIR = path.resolve('data');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const VAULT_FILE = path.join(DATA_DIR, 'vault.json');
export const STATS_FILE = path.join(DATA_DIR, 'vault-stats.json');
export const RUN_FILE = path.join(DATA_DIR, 'last-run.json');
export const LIVENESS_FILE = path.join(DATA_DIR, 'liveness.json');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT' && ![VAULT_FILE, STATE_FILE].includes(file)) return fallback;
    throw new Error(`Cannot load required data ${file}: ${error.message}`);
  }
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
  if (!Array.isArray(vault) || !vault.length) throw new Error('vault must be a non-empty array');
  if (!state.done || Array.isArray(state.done) || typeof state.done !== 'object') throw new Error('Invalid state.done');
  return { state, vault };
}

export function buildStats(vault = [], state = {}) {
  const stored = vault.filter((m) => m.embeds?.length);
  const series = stored.filter((m) => m.kind === 'series');
  const tracked = Object.values(state.done || {});
  const empties = tracked.filter((v) => v?.empty);
  return {
    updatedAt: new Date().toISOString(),
    // The freshness signal: when the last genuinely-new record landed. The
    // watchdog reads this instead of trusting the run to have happened.
    lastAddedAt: stored.reduce((max, m) => (m.addedAt > max ? m.addedAt : max), ''),
    processed: Object.keys(state.done || {}).length,
    movies: stored.length - series.length,
    series: series.length,
    totalRecords: stored.length,
    episodes: series.reduce((n, m) => n + (m.seasons || []).reduce((a, s) => a + s.episodes.length, 0), 0),
    embedLinks: stored.reduce((n, m) => n + m.embeds.length, 0),
    withPoster: stored.filter((m) => m.poster).length,
    // health of the retry pipeline — a growing `deadPages` is a site change,
    // a growing `emptyPages` is normal (unreleased titles), `partialPages`
    // should always drain to ~0 within a day.
    emptyPages: empties.length,
    deadPages: empties.filter((v) => v.dead).length,
    partialPages: tracked.filter((v) => v?.partial).length,
    letters: state.letters || {},
  };
}

/** Persist vault + state + stats (+ derived consumer files) in one pass. */
export function saveAll({ state, vault }) {
  writeJson(VAULT_FILE, vault);
  writeJson(STATE_FILE, state);
  const stats = buildStats(vault, state);
  writeJson(STATS_FILE, stats);
  writeDerived(vault, stats);
  return stats;
}

/** The run report (<data/last-run.json>) — read by the watchdog and the app. */
export function saveRun(report) {
  writeJson(RUN_FILE, { at: new Date().toISOString(), ...report });
  return report;
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
 * { action: 'added' | 'merged' | 'unchanged', record, changed }.
 *
 * v2.1: `changed` diffs the WHOLE record, not just `embeds`. Adding a season,
 * promoting a movie to a series or filling in a poster used to report
 * `unchanged` — the run summary under-reported work and `updatedAt` was never
 * stamped (only 42/2,842 records had it).
 */
const snapshot = (m) => JSON.stringify([m.title, m.year, m.embeds, m.seasons, m.poster, m.rating, m.tmdbId, m.imdbId]);

/**
 * Is this "new" series really one we already have under a different page?
 *
 * The site re-lists a returning show on a fresh URL each season ("Bigg Boss
 * (2026)" → /bigg-boss-2026-tamil-web-series/), so the discovered title and id
 * differ while the show is the same and the episodes overlap. Without this, a
 * re-listing becomes a near-duplicate record (and the two halves of the season
 * end up split across two tiles).
 *
 * Rule: same base title (season/part/year tokens stripped) AND >= 3 shared
 * episode numbers. Two different shows sharing a base title *and* three episode
 * numbers is not a thing.
 */
export function findSeriesTwin(vault, record) {
  if (record?.kind !== 'series') return null;
  const normalise = (value) => String(value || '')
    .toLowerCase()
    .replace(/\b(season|part|vol|volume)\s*\d+\b/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const seasonsOf = (m) => new Set((m.seasons || []).map((s) => Number(s.season)).filter(Number.isFinite));
  /** Episode numbers, restricted to `seasons` when it is non-empty. */
  const episodesOf = (m, seasons) => (m.seasons || [])
    .filter((s) => !seasons.size || seasons.has(Number(s.season)))
    .flatMap((s) => s.episodes.map((e) => Number(e.episode)))
    .filter(Number.isFinite);

  const myTitle = normalise(record.title);
  if (!myTitle) return null;
  const mySeasons = seasonsOf(record);
  const mine = new Set(episodesOf(record, mySeasons));
  if (mine.size < 3) return null;

  let best = null;
  let bestShared = 0;
  let bestGap = Infinity;
  for (const candidate of vault) {
    if (candidate?.kind !== 'series' || candidate.id === record.id) continue;
    if (normalise(candidate.title) !== myTitle) continue;
    const urls = new Set((record.embeds || []).map(e => e.url));
    if (!(candidate.embeds || []).some(e => urls.has(e.url))) continue;

    // A re-listed SEASON must never be unioned into a different season of the
    // same show. "Bigg Boss Season 9" (106 episodes) shares episode numbers 6..25
    // with the season-10 page — title alone would merge them and corrupt both.
    const theirSeasons = seasonsOf(candidate);
    const comparable = mySeasons.size && theirSeasons.size;
    if (comparable && ![...mySeasons].some((n) => theirSeasons.has(n))) continue;

    const theirs = episodesOf(candidate, comparable ? mySeasons : new Set());
    const shared = theirs.filter((n) => mine.has(n)).length;
    if (shared < 3) continue;

    const gap = Math.abs((Number(candidate.year) || 0) - (Number(record.year) || 0));
    if (shared > bestShared || (shared === bestShared && gap < bestGap)) {
      best = candidate; bestShared = shared; bestGap = gap;
    }
  }
  return best;
}

export function upsertRecord(vault, record) {
  if (!record?.id || !record.embeds?.length) return { action: 'unchanged', record: null, changed: null };
  let index = vault.findIndex((m) => m.id === record.id);
  let twin = null;

  // A series re-listed on a new page merges into the record we already have,
  // keeping that record's id (deep links) and title (the site's own name).
  if (index < 0) {
    twin = findSeriesTwin(vault, record);
    if (twin) index = vault.indexOf(twin);
  }

  if (index < 0) {
    const created = { ...record, addedAt: record.addedAt || new Date().toISOString() };
    vault.push(created);
    return { action: 'added', record: created, changed: { created: true } };
  }

  const existing = vault[index];
  const before = snapshot(existing);
  existing.embeds = mergeEmbeds(existing.embeds, record.embeds);
  if (record.kind === 'series' || record.seasons?.length) {
    existing.kind = 'series';
    existing.seasons = mergeSeasons(existing.seasons, record.seasons || []);
    existing.embeds = existing.seasons.flatMap(s => s.episodes.flatMap(ep => ep.embeds.map(e => ({ ...e, season: s.season, episode: ep.episode }))));
  }
  // fill metadata gaps without ever downgrading what is already there
  for (const key of ['poster', 'imdbId']) if (!existing[key] && record[key]) existing[key] = record[key];
  for (const key of ['rating', 'tmdbId']) if (!existing[key] && record[key]) existing[key] = record[key];
  if (!existing.year && record.year) existing.year = record.year;

  const changed = before !== snapshot(existing);
  if (changed) existing.updatedAt = new Date().toISOString();
  return {
    action: changed ? 'merged' : 'unchanged',
    record: existing,
    changed: { embeds: changed },
    ...(twin ? { twin: twin.id } : {}),
  };
}

/** Record a hit so the delta layer knows about it. Clears any failure state. */
export function markDone(state, url, payload) {
  state.done[url] = { at: new Date().toISOString(), ...payload };
  return state.done[url];
}

/**
 * Record a page that WAS read and genuinely had no live embed yet.
 * The widening ladder advances: 12h → 1d → 3d → 7d → 30d, then exhausted.
 */
export function markEmpty(state, url, { kind } = {}) {
  const previous = state.done[url] || {};
  const retries = Number(previous.retries || 0) + 1;
  state.done[url] = {
    at: new Date().toISOString(),
    empty: true,
    retries,
    // rung = verdicts already spent: the 1st empty result is re-checked in 12h
    // (a title that goes live the same evening is caught by the catch-up run),
    // then 1d / 3d / 7d / 30d, then exhausted.
    retryAfter: nextRetryAt(retries - 1),
    ...(kind ? { kind } : {}),
  };
  return state.done[url];
}

/**
 * Record a page we could NOT read (5xx, timeout, connection reset).
 *
 * This is the fix that makes the nightly run correct: a failed read must not
 * advance the empty-page ladder, or one 502 defers a brand-new release by
 * 12h/1d/3d/7d/30d. The item is re-tried 90 minutes later instead — usually in
 * the same night's catch-up run. After MAX_FAILURES consecutive failures it is
 * assumed deleted and marked `dead` so it stops costing requests forever.
 */
export function markFailed(state, url, { kind, error } = {}) {
  const previous = state.done[url] || {};
  const failures = Number(previous.failures || 0) + 1;
  const dead = false; // transient/global failures must never retire a page permanently
  state.done[url] = {
    at: new Date().toISOString(),
    empty: true,                  // still "tracked, not stored"
    retries: Number(previous.retries || 0), // ladder position is UNCHANGED
    retryAfter: new Date(Date.now() + Math.min(24 * 60, 90 * 2 ** Math.min(failures - 1, 4)) * 60000).toISOString(),
    failures,
    ...(dead ? { dead: true } : {}),
    ...(error ? { lastError: String(error).slice(0, 160) } : {}),
    ...(kind ? { kind } : {}),
  };
  return state.done[url];
}

/**
 * Record a walk that succeeded but could not read every hop — the item IS
 * stored, so this only schedules one re-walk to union in what was missed.
 */
export function markPartial(state, url, { kind, embeds, failures } = {}) {
  state.done[url] = {
    at: new Date().toISOString(),
    embeds: Number(embeds || 0),
    partial: true,
    rechecks: Number(state.done[url]?.rechecks || 0) + (state.done[url]?.partial ? 1 : 0),
    failures: Number(failures || 0),
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
    poster: walked.poster || '',
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

/**
 * data/liveness.json — when each record's embeds were last verified.
 *
 * Kept OUT of vault.json on purpose: the sweep touches every record's timestamp
 * nightly, and rewriting the 1.8 MB catalogue for that would churn git (and the
 * consumers' cache) for no content change.
 *   { "<record id>": { "at": ISO, "live": n, "dead": n, "unknown": n } }
 */
export const loadLiveness = () => readJson(LIVENESS_FILE, {});
export const saveLiveness = (liveness) => writeJson(LIVENESS_FILE, liveness);

/** Records whose embeds have not been checked in a while, oldest first. */
export function planLiveness(vault, liveness = {}, { limit = 0, maxAgeDays = 0, onlyIds = null } = {}) {
  const now = Date.now();
  const wanted = onlyIds ? new Set(onlyIds) : null;
  const rows = vault
    .filter((m) => m.embeds?.length && (!wanted || wanted.has(m.id)))
    .map((m) => ({ record: m, at: Date.parse(liveness[m.id]?.at || '') || 0 }));
  const stale = maxAgeDays ? rows.filter((r) => now - r.at > maxAgeDays * 86_400_000) : rows;
  stale.sort((a, b) => a.at - b.at); // never-checked (0) first, then oldest
  const chosen = limit ? stale.slice(0, limit) : stale;
  return { chosen, neverChecked: rows.filter((r) => !r.at).length, total: rows.length };
}
