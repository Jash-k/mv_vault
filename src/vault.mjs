/**
 * vault.mjs — everything that touches data/. No network here.
 *
 * Writes exactly three files, all in the shape your app already reads:
 *
 *   data/vault.json  [ { id, title, year, [kind], [category], [originalLanguage],
 *                        [categorySource], pageUrl, embeds[{quality,url[,season,episode]}],
 *                        poster, rating, tmdbId, imdbId, addedAt, [seasons], [updatedAt] } ]
 *   data/index.json  [ { i, t, y, k, r, p } ]            (browse index, vault order)
 *   data/state.json  { done: { "<pageUrl>": { at, embeds } | { at, empty, retries, … } } }
 *
 * data/az.json is the A–Z cursor and holds nothing else: { letter, page, pass }.
 *
 * Rules kept from the old pipeline on purpose:
 *   · fresh embeds are UNIONED in, never substituted — a temporarily missing
 *     quality never deletes a link you already proved live;
 *   · the flat embeds[] of a series is always rebuilt from seasons[], so the two
 *     can never disagree (that invariant is what your app relies on);
 *   · metadata is only ever filled, never downgraded;
 *   · writes are atomic (tmp + rename), so a kill mid-write cannot corrupt data.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DATA = 'data';
export const VAULT_FILE = path.join(DATA, 'vault.json');
export const INDEX_FILE = path.join(DATA, 'index.json');
export const STATE_FILE = path.join(DATA, 'state.json');
export const AZ_FILE = path.join(DATA, 'az.json');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
};

/** Atomic write, 1-space indent for vault/state (same as the existing files). */
export function writeJson(file, value, { indent = 1 } = {}) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, indent)}\n`);
  fs.renameSync(tmp, file);
}

export function loadVault() {
  const vault = readJson(VAULT_FILE, null);
  if (!Array.isArray(vault) || !vault.length) throw new Error('data/vault.json must exist and be a non-empty array');
  return vault;
}
export const loadState = () => {
  const state = readJson(STATE_FILE, { done: {}, letters: {} });
  state.done = state.done || {};
  return state;
};
export const loadAz = () => readJson(AZ_FILE, { letter: 'a', page: 1, pass: 1 });
export const saveAz = (cursor) => writeJson(AZ_FILE, cursor);

export function saveAll(vault, state) {
  writeJson(VAULT_FILE, vault);
  writeJson(INDEX_FILE, vault.map((m) => ({
    i: m.id, t: m.title, y: m.year || 0, k: m.kind === 'series' ? 's' : 'm',
    c: m.category || '', r: m.rating || 0, p: m.poster || '',
  })), { indent: 0 });
  writeJson(STATE_FILE, state);
}

/* ------------------------------------------------------- titles, ids, paths */

export const pathOf = (value) => {
  try { return new URL(value, 'https://moviesda34.com').pathname.replace(/\/+$/, '') + '/'; } catch { return String(value || ''); }
};
export const canonicalUrl = (path) => `https://moviesda34.com${pathOf(path)}`;
export const slugify = (value = '') => String(value)
  .toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const YEAR_RX = /(19\d{2}|20[0-3]\d)/;
const TYPE_SUFFIX = /-(?:tamil-)?web-series$|-tamil-season-\d+$|-tamil-dubbed-movie$|-tamil-movie-moviesda$|-movie-moviesda$|-tamil-movie$|-movie$|-(?:tamil-)?movie-\d+$|-moviesda(?:-page)?$/;
const LANG_TAIL = /-(?:tamil|telugu|hindi|malayalam|kannada|english|dubbed|hd|hq|original|proper|predvd|dvdrip|hdrip|tvrip|webrip|bluray|1080p|720p|480p|360p)+$/i;
const LABEL_TAIL = /(?:\s+(?:tamil|telugu|hindi|malayalam|kannada|english|dubbed|hd|hq|original|proper|predvd|dvdr|dvdrip|hdrip|tvrip|webrip|bluray|1080p|720p|480p|360p))+$/i;
const GENERIC_LABEL = /^(?:download(?:\s+now|\s+link[s]?|\s+file)?|watch(?:\s+online)?|click\s+here|play(?:\s+now)?|full\s+movie|movie|server\s*\d*|link|file|zip|now|here|get\s+it|start\s+download)$/i;
const titleCase = (s) => s.split(' ').map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');

/** { title, year } from a URL path alone (listings without labels, redirects). */
export function titleFromPath(path = '') {
  let s = pathOf(path).replace(/^\/+|\/+$/g, '').replace(TYPE_SUFFIX, '');
  const years = [...s.matchAll(new RegExp(`(?:^|-)${YEAR_RX.source}(?=-|$)`, 'g'))];
  const hit = years.length ? years[years.length - 1] : s.match(YEAR_RX);
  const year = hit ? Number(hit[1]) : 0;
  if (hit) s = `${s.slice(0, hit.index)}-${s.slice(hit.index + hit[0].length)}`;
  s = s.replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  let prev;
  do { prev = s; s = s.replace(TYPE_SUFFIX, ''); } while (s !== prev);
  do { prev = s; s = s.replace(LANG_TAIL, ''); } while (s !== prev);
  return { title: titleCase(s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()), year };
}

/** { title, year } from a listing label, with the site's junk stripped. */
export function cleanTitle(label = '', path = '') {
  let s = String(label || '').replace(/\s+/g, ' ').trim();
  if (!s) return titleFromPath(path);
  const ym = s.match(/\((19|20)\d{2}\)/);
  let year = ym ? Number(ym[0].replace(/[()]/g, '')) : 0;
  if (ym) s = s.slice(0, ym.index).trim();
  if (!year) {
    const bare = s.match(new RegExp(`\\s${YEAR_RX.source}(?:\\s|$)`));
    if (bare) { year = Number(bare[1]); s = `${s.slice(0, bare.index)} ${s.slice(bare.index + bare[0].length)}`.trim(); }
  }
  let prev;
  do { prev = s; s = s.replace(/\s*\(([^)]*)\)\s*$/, (m, inner) => (/(hd|dvd|web|blu|rip|1080p|720p|480p|360p|original|tamil|dubbed|proper|uncut)/i.test(inner) ? '' : m)).trim(); } while (s !== prev);
  do { prev = s; s = s.replace(/\s*\b(?:hd|dvdrip|hdrip|webrip|web-dl|tvrip|hdtv|predvd|1080p|720p|480p|360p|x264|bluray|original|movie)\b\s*$/gi, '').trim(); } while (s !== prev);
  do { prev = s; s = s.replace(LABEL_TAIL, ''); } while (s !== prev);
  const title = s.replace(/\s*[-–]\s*$/, '').trim();
  return title ? { title, year } : titleFromPath(path);
}

/** Final { title, year } for a discovered item. Returns null when it is junk. */
export function titleFor(item) {
  const fromPath = titleFromPath(item.path);
  let label = cleanTitle(item.label, item.path);
  if (!label.title || GENERIC_LABEL.test(label.title) || /^\(/.test(label.title)) label = null;
  let title = label?.title || fromPath.title;
  let year = label?.year || 0;
  if (!year && fromPath.year) {
    // no year on the label → the path usually has the real one
    const richer = label && (/[()[\].:]/.test(label.title) || label.title.split(' ').length > fromPath.title.split(' ').length);
    if (!label || !richer) { title = fromPath.title || title; year = fromPath.year; }
    else year = fromPath.year;
  }
  if (!title || !/[a-z0-9]/i.test(title) || !slugify(title)) return null;
  return { title, year };
}

export const idFor = (title, year) => `${slugify(title)}${year ? `-${year}` : ''}`;

/* --------------------------------------------------------------- categories */

/**
 * The four buckets, all Tamil audio (the site publishes Tamil audio only):
 *   tamil-movie · tamil-dubbed-movie · tamil-series · tamil-dubbed-series
 *
 * "Tamil" vs "Tamil dubbed" is ORIGIN, and the only reliable signal is TMDB's
 * original_language (the item page always says "Language: Tamil" — that is the
 * audio track, not the origin). When TMDB has no match, the site's own
 * /tamil-dubbed-movies/ section is used as the evidence instead, and the record
 * is marked categorySource: "site" so a TMDB result can replace it later.
 */
export const CATEGORY_TAMIL = 'tamil';
export const CATEGORY_DUBBED = 'tamil-dubbed';

export const isDubbedLang = (lang) => Boolean(lang) && String(lang).toLowerCase() !== 'ta';

/** 'tamil-movie' | 'tamil-dubbed-movie' | 'tamil-series' | 'tamil-dubbed-series' | null */
export function categoryFor(kind, originalLanguage) {
  if (!originalLanguage) return null;
  const base = kind === 'series' ? 'series' : 'movie';
  return `${isDubbedLang(originalLanguage) ? CATEGORY_DUBBED : CATEGORY_TAMIL}-${base}`;
}

/** Site-evidence category (the dubbed section listed this path). */
export const categoryFromSite = (kind, dubbed) => `${dubbed ? CATEGORY_DUBBED : CATEGORY_TAMIL}-${kind === 'series' ? 'series' : 'movie'}`;

/**
 * Set the category from site evidence. Never overwrites a TMDB-derived category,
 * and marks the source so `--stale-days` can re-try it against TMDB later.
 */
export function applySiteCategory(record, dubbed) {
  if (record.categorySource === 'tmdb') return false;
  const wanted = categoryFromSite(record.kind, dubbed);
  if (record.category === wanted && record.categorySource === 'site') return false;
  record.category = wanted;
  record.categorySource = 'site';
  return true;
}

/* ------------------------------------------------------------------- merge */

const qualityRank = (q) => (q === '1080p' ? 0 : q === '720p' ? 1 : q === '480p' ? 2 : q === '360p' ? 3 : 4);
const mergeEmbeds = (existing = [], fresh = []) => {
  const seen = new Set(existing.map((e) => e.url));
  const out = existing.slice();
  for (const e of fresh) if (e?.url && !seen.has(e.url)) { seen.add(e.url); out.push(e); }
  return out;
};

/** Union of seasons → episodes → embeds. Deterministic order (season, episode, quality). */
function mergeSeasons(existing = [], fresh = []) {
  const map = new Map(existing.map((s) => [Number(s.season), new Map((s.episodes || []).map((e) => [Number(e.episode), { episode: Number(e.episode), embeds: (e.embeds || []).slice() }]))]));
  for (const s of fresh || []) {
    const key = Number(s.season);
    if (!map.has(key)) map.set(key, new Map());
    const eps = map.get(key);
    for (const ep of s.episodes || []) {
      const ek = Number(ep.episode);
      if (!eps.has(ek)) { eps.set(ek, { episode: ek, embeds: (ep.embeds || []).slice() }); continue; }
      const target = eps.get(ek);
      target.embeds = mergeEmbeds(target.embeds, ep.embeds || []).sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality));
    }
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([season, eps]) => ({
    season,
    episodes: [...eps.values()].sort((a, b) => a.episode - b.episode),
  }));
}

/** flat embeds[] is ALWAYS derived from seasons[] (never maintained twice). */
const flatten = (seasons = []) => seasons.flatMap((s) => s.episodes.flatMap((ep) => ep.embeds.map((e) => ({ quality: e.quality, url: e.url, season: s.season, episode: ep.episode }))));

/** Rebuild a record in the exact key order the existing vault uses. */
function order(record) {
  const out = {
    id: record.id, title: record.title, year: record.year || 0,
    ...(record.kind === 'series' ? { kind: 'series' } : {}),
    // only present once known, so untouched records stay byte-identical
    ...(record.category ? { category: record.category } : {}),
    ...(record.originalLanguage ? { originalLanguage: record.originalLanguage } : {}),
    ...(record.category ? { categorySource: record.categorySource || 'tmdb' } : {}),
    pageUrl: record.pageUrl, embeds: record.embeds || [], poster: record.poster || '',
    rating: record.rating || 0, tmdbId: record.tmdbId || 0, imdbId: record.imdbId || '',
    addedAt: record.addedAt,
    ...(record.kind === 'series' ? { seasons: record.seasons || [] } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
  };
  for (const [k, v] of Object.entries(record)) if (!(k in out)) out[k] = v; // keep unknown extras
  return out;
}

/**
 * A returning web series is re-listed on a NEW page each season ("Bigg Boss
 * (2026)" → /bigg-boss-2026-tamil-web-series/) while it is the same show, so a
 * naive upsert creates a near-duplicate record and splits the season in two.
 * Rule: same base title (season/part/year stripped) AND >= 3 shared episode
 * numbers → same show.
 */
function findSeriesTwin(vault, record) {
  if (record.kind !== 'series') return null;
  const base = (t) => String(t || '').toLowerCase().replace(/\b(season|part|vol|volume)\s*\d+\b/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const bySeason = (r) => new Map((r.seasons || []).map((s) => [Number(s.season), new Set(s.episodes.map((e) => Number(e.episode)))]));
  const mine = bySeason(record);
  const mineCount = [...mine.values()].reduce((n, s) => n + s.size, 0);
  if (mineCount < 3 || !base(record.title)) return null;
  let best = null;
  let bestShared = 0;
  for (const other of vault) {
    if (other.kind !== 'series' || base(other.title) !== base(record.title)) continue;
    const theirs = bySeason(other);
    let shared = 0;
    // Same SHOW means the same season with the same episodes. A different
    // season of the same title is a different record on purpose (see the
    // separate Bigg Boss Season 9 / Season 10 records in the vault).
    for (const [season, episodes] of mine) {
      const otherEpisodes = theirs.get(season);
      if (!otherEpisodes) continue;
      for (const episode of episodes) if (otherEpisodes.has(episode)) shared += 1;
    }
    if (shared > bestShared) { bestShared = shared; best = other; }
  }
  return bestShared >= 3 ? best : null;
}

const snapshot = (m) => JSON.stringify([m.embeds, m.seasons, m.poster, m.rating, m.tmdbId, m.imdbId, m.category, m.originalLanguage]);
const episodesOf = (m) => (m?.seasons || []).reduce((n, s) => n + s.episodes.length, 0);

/**
 * Merge one walked item into the vault.
 * Returns { action: 'added' | 'merged' | 'unchanged', record, previousEpisodes }
 * — previousEpisodes is the count BEFORE the merge, so a caller can report
 * "+N episodes" correctly even when the record was matched by identity rather
 * than by page path (a series re-listed on a new page).
 */
export function upsert(vault, item, walked, now = new Date().toISOString()) {
  const title = item.title;
  const year = item.year || 0;
  const kind = walked.kind === 'series' ? 'series' : 'movie';
  const isSeries = kind === 'series';
  const embeds = isSeries ? flatten(walked.seasons || []) : (walked.embeds || []);
  if (!embeds.length) return { action: 'unchanged', record: null };

  const fresh = {
    id: idFor(title, year),
    title, year,
    ...(isSeries ? { kind: 'series' } : {}),
    pageUrl: item.url,
    embeds,
    poster: walked.poster || '',
    rating: 0, tmdbId: 0, imdbId: '',
    addedAt: now,
    ...(isSeries ? { seasons: walked.seasons || [] } : {}),
  };

  const byPath = pathOf(item.url);
  let existing = vault.find((m) => m.id === fresh.id) || vault.find((m) => pathOf(m.pageUrl) === byPath);
  if (!existing && isSeries) existing = findSeriesTwin(vault, fresh);
  if (!existing) {
    const created = order(fresh);
    vault.push(created);
    return { action: 'added', record: created, previousEpisodes: 0 };
  }
  const previousEpisodes = episodesOf(existing);

  const before = snapshot(existing);
  existing.embeds = mergeEmbeds(existing.embeds, embeds);
  if (isSeries) {
    existing.kind = 'series';
    existing.seasons = mergeSeasons(existing.seasons, walked.seasons || []);
    existing.embeds = flatten(existing.seasons);
  }
  if (!existing.poster && fresh.poster) existing.poster = fresh.poster;
  if (!existing.year && year) existing.year = year;
  const changed = before !== snapshot(existing);
  if (changed) existing.updatedAt = now;
  const rebuilt = order(existing);
  Object.keys(existing).forEach((k) => delete existing[k]);
  Object.assign(existing, rebuilt);
  return { action: changed ? 'merged' : 'unchanged', record: existing, previousEpisodes };
}

/**
 * Fill poster/rating/tmdbId/imdbId from TMDB without ever downgrading anything.
 * `preferPoster` is used for records ADDED in this run so they match the style
 * of the rest of the vault (TMDB artwork); existing records are only ever
 * filled when their poster is empty.
 */
export function applyMetadata(record, meta, { preferPoster = false } = {}) {
  if (!meta) return false;
  let changed = false;
  if (meta.poster && (preferPoster || !record.poster) && record.poster !== meta.poster) { record.poster = meta.poster; changed = true; }
  if (!record.tmdbId && meta.tmdbId) { record.tmdbId = meta.tmdbId; changed = true; }
  if (!record.imdbId && meta.imdbId) { record.imdbId = meta.imdbId; changed = true; }
  if (!record.rating && meta.rating) { record.rating = meta.rating; changed = true; }

  // category: TMDB's original_language is the authority, and it also replaces a
  // previous site guess.
  if (meta.originalLanguage) {
    if (!record.originalLanguage) { record.originalLanguage = meta.originalLanguage; changed = true; }
    const wanted = categoryFor(record.kind, meta.originalLanguage);
    if (wanted && (record.category !== wanted || record.categorySource !== 'tmdb')) {
      record.category = wanted;
      record.categorySource = 'tmdb';
      changed = true;
    }
  }
  if (changed) record.updatedAt = new Date().toISOString();
  return changed;
}

export const needsMetadata = (record) => !record.tmdbId || !record.poster;
export const needsCategory = (record) => !record.category;
