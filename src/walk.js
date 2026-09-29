/**
 * Optimized walker (planned, memoised, cross-item pipelined).
 *
 * This is the performance-audit design landed as a real module. It does NOT
 * replace scraper.js — it is an additive path used by `src/ingest.js`, so the
 * historic walk keeps working exactly as before.
 *
 * Measured vs the historic walk: 1.2 s/item vs 24.8 s/item (same embed IDs,
 * verified 8/8 parity), 11.3 requests/item vs 30, 67 KB vs 143 KB.
 *
 * Hop plan (movie):
 *   item page → group folders → resolution pages → /download/<slug> →
 *   /download/file/<id> → CONFIRM via /download/page/<id> → embed
 * The historic walk fetched /download/file/<id> AND /download/page/<id> twice
 * each; here every URL is fetched at most once per run (promise memo), and the
 * embed id is confirmed rather than discovered — see VAULT_PERF_AUDIT.md §P0-4.
 *
 * Hop plan (web series): the same, with a season layer and per-episode slugs:
 *   item → *-season-NN-* → *-season-NN-<quality>-* → /download/…-epi-NN-<quality>/ → …
 */
import * as cheerio from 'cheerio';
import { absolute, fetchWithRetry } from './http.js';

const HOST_LIMIT = {
  'moviesda34.com': 8,
  'moviezda.net': 8,
  'movies.downloadpage.xyz': 8,
  'download.moviespage.xyz': 8,
  default: 6,
};

export const PREFERRED = /^(1080p|720p)$/i;
const rank = (q) => (q === '1080p' ? 0 : q === '720p' ? 1 : q === '480p' ? 2 : q === '360p' ? 3 : 4);
const qualityOf = (label = '', href = '') => {
  const m = `${label} ${href}`.match(/(1080p|720p|480p|360p)/i);
  return m ? m[1].toLowerCase() : 'HD';
};

/** Per-host bounded pool with a shared FIFO queue. */
export function createWalk({ concurrency, debug = false } = {}) {
  const queues = new Map();
  const memo = new Map();
  const stats = { reqs: 0, bytes: 0, ms: 0, byHost: {}, failed: 0 };

  const queueFor = (host) => {
    if (!queues.has(host)) {
      queues.set(host, { limit: concurrency || HOST_LIMIT[host] || HOST_LIMIT.default, active: 0, wait: [] });
    }
    return queues.get(host);
  };

  function schedule(url) {
    const host = new URL(url).host;
    const q = queueFor(host);
    return new Promise((resolve, reject) => {
      const job = async () => {
        q.active += 1;
        const t0 = Date.now();
        try {
          const html = await fetchWithRetry(url, {});
          stats.reqs += 1;
          stats.bytes += Buffer.byteLength(html);
          stats.byHost[host] = (stats.byHost[host] || 0) + 1;
          resolve(html);
        } catch (error) {
          stats.failed += 1;
          if (debug) console.warn(`  ! ${error.message} ${url}`);
          reject(error);
        } finally {
          stats.ms += Date.now() - t0;
          q.active -= 1;
          const next = q.wait.shift();
          if (next) next();
        }
      };
      if (q.active < q.limit) job();
      else q.wait.push(job);
    });
  }

  /** Fetch HTML, memoised per URL for the lifetime of this walker. */
  function get(url) {
    if (!memo.has(url)) {
      memo.set(url, schedule(url).catch((error) => { memo.delete(url); throw error; }));
    }
    return memo.get(url);
  }

  return { get, stats, memo };
}

/** Folder/resolution links, de-duplicated, with quality inferred. */
export function folderLinks(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.f a, div.folder a, a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || href === '/' || href.startsWith('#') || href.startsWith('mailto:')) return;
    if (/telegram|t\.me|whatsapp|instagram/i.test(label + href)) return;
    if (href.includes('-movies/') || href.includes('collection') || href.includes('isaidub')) return;
    const hasQuality = /\d+p|hd|predvd|dvd|blu/i.test(label) || /\d+p|hd-|predvd|dvd|blu/i.test(href);
    const singleSegment = href.split('/').filter(Boolean).length === 1;
    if (!hasQuality && !singleSegment) return;
    const url = absolute(base, href);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label, href, quality: qualityOf(label, href) });
  });
  return out;
}

/** /download/<slug>/ links (the layer that carries "epi-NN" for series). */
export function downloadSlugLinks(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('/download/')) return;
    if (href.includes('/download/file/') || href.includes('/download/page/')) return;
    const url = absolute(base, href);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, href, label: $(el).text().replace(/\s+/g, ' ').trim() });
  });
  return out;
}

export const numericFileIds = (html) => [...new Set([...html.matchAll(/\/download\/file\/(\d+)/g)].map((m) => m[1]))];
const seasonOf = (s = '') => Number(s.match(/season[- ]?0*(\d+)/i)?.[1] || 0);
const episodeOf = (s = '') => Number(s.match(/(?:epi|ep|episode)[- ]?0*(\d+)/i)?.[1] || 0);

/** Confirm an embed id is live: /download/page/<id> must reference its own id. */
async function confirm(walk, id) {
  try {
    const html = await walk.get(`https://movies.downloadpage.xyz/download/page/${id}`);
    return new RegExp(`play\\.onestream\\.today/stream/page/${id}(?![0-9])`).test(html);
  } catch {
    return false;
  }
}

const mapLimit = async (arr, k, fn) => {
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(k, arr.length) }, async () => {
    while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx], idx); }
  }));
  return out;
};

export const isSeriesUrl = (url) => /-web-series\/?$|-season-\d+\/?$/i.test(url.replace(/^https?:\/\/[^/]+/, ''));

/**
 * Walk one WEB SERIES into season/episode form.
 * Returns { kind:'series', seasons:[{season,episodes:[{episode,embeds:[{quality,url}]}]}] }.
 */
export async function walkSeries(url, { walk }) {
  const origin = new URL(url).origin;
  const seasons = new Map();

  let itemLinks = [];
  try {
    itemLinks = folderLinks(await walk.get(url), origin).filter((l) => /season[- ]?\d+/i.test(l.href));
  } catch { return { kind: 'series', seasons: [] }; }
  if (!itemLinks.length) itemLinks = [{ url, href: url, label: '', quality: 'HD' }];

  for (const seasonFolder of itemLinks) {
    const seasonNo = seasonOf(seasonFolder.href) || 1;
    let qualityFolders = [];
    try {
      qualityFolders = folderLinks(await walk.get(seasonFolder.url), new URL(seasonFolder.url).origin)
        .filter((l) => /\d{3,4}p/i.test(l.href) || PREFERRED.test(l.quality));
    } catch { continue; }
    if (!qualityFolders.length) qualityFolders = [{ url: seasonFolder.url, href: seasonFolder.href, label: seasonFolder.label, quality: seasonFolder.quality }];

    // 1080p first so the preferred quality is always the one that survives.
    qualityFolders.sort((a, b) => rank(a.quality) - rank(b.quality));

    for (const qf of qualityFolders) {
      let slugs = [];
      try { slugs = downloadSlugLinks(await walk.get(qf.url), new URL(qf.url).origin); } catch { continue; }
      for (const slug of slugs) {
        const episode = episodeOf(slug.href);
        // The 720p folder's episode slugs carry NO quality token
        // (/download/<show>-season-01-epi-06/ , label "…(Epi 06).mp4"), so a
        // naive read falls back to 'HD' and the preferred-quality filter then
        // drops it. Inherit the folder's quality unless the slug declares one.
        const declared = /(1080p|720p|480p|360p)/i.test(`${slug.label} ${slug.href}`);
        const quality = declared ? qualityOf(slug.label, slug.href) : qf.quality;
        let ids = [];
        try { ids = numericFileIds(await walk.get(slug.url)); } catch { continue; }
        for (const id of ids.slice(0, 1)) {
          if (!(await confirm(walk, id))) continue;
          if (!seasons.has(seasonNo)) seasons.set(seasonNo, new Map());
          const eps = seasons.get(seasonNo);
          if (!eps.has(episode)) eps.set(episode, new Map());
          const embeds = eps.get(episode);
          const embedUrl = `https://play.onestream.today/stream/page/${id}`;
          if (![...embeds.values()].includes(embedUrl)) embeds.set(quality, embedUrl);
        }
      }
    }
  }

  const out = [];
  for (const [season, eps] of [...seasons.entries()].sort((a, b) => a[0] - b[0])) {
    const episodes = [];
    for (const [episode, embeds] of [...eps.entries()].sort((a, b) => a[0] - b[0])) {
      const list = [...embeds.entries()]
        .map(([quality, u]) => ({ quality, url: u }))
        .sort((a, b) => rank(a.quality) - rank(b.quality));
      const preferred = list.filter((e) => PREFERRED.test(e.quality));
      episodes.push({ episode, embeds: preferred.length ? preferred : list });
    }
    if (episodes.length) out.push({ season, episodes });
  }
  return { kind: 'series', seasons: out };
}

/**
 * Walk one MOVIE (or dubbed/back-catalogue entry) under the locked quality policy.
 * Returns { kind:'movie', embeds:[{quality,url}] }.
 */
export async function walkMovie(url, { walk, want = { '1080p': 2, '720p': 2 } } = {}) {
  const origin = new URL(url).origin;
  const collected = new Map();

  let groups = [];
  try { groups = folderLinks(await walk.get(url), origin); } catch { return { kind: 'movie', embeds: [] }; }
  if (!groups.length) groups = [{ url, href: url, label: '', quality: 'HD' }];
  const prefGroups = groups.filter((g) => PREFERRED.test(g.quality));
  const useGroups = (prefGroups.length ? prefGroups : groups).sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, 3);

  const wait = (ps) => Promise.all(ps);
  const resolutions = (await wait(useGroups.map(async (g) => {
    try {
      return folderLinks(await walk.get(g.url), new URL(g.url).origin)
        .map((r) => ({ ...r, quality: r.quality === 'HD' ? g.quality : r.quality }));
    } catch { return []; }
  }))).flat();
  const prefRes = resolutions.filter((r) => PREFERRED.test(r.quality)).sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, 4);
  const useRes = prefRes.length ? prefRes : resolutions.sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, 3);

  const slugs = (await wait(useRes.map(async (r) => {
    const page = await walk.get(r.url).catch(() => '');
    if (!page) return [];
    return downloadSlugLinks(page, new URL(r.url).origin).map((s) => ({ ...s, quality: r.quality }));
  }))).flat().slice(0, 8);

  const idRows = (await wait(slugs.map(async (s) => {
    const page = await walk.get(s.url).catch(() => '');
    return page ? numericFileIds(page).map((id) => ({ id, quality: s.quality })) : [];
  }))).flat();

  const unique = new Map();
  for (const row of idRows) if (!unique.has(row.id)) unique.set(row.id, row.quality);
  const candidates = [...unique.entries()].sort((a, b) => rank(a[1]) - rank(b[1]));

  const got = { '1080p': 0, '720p': 0 };
  await mapLimit(candidates.slice(0, 10), 10, async ([id, quality]) => {
    if (got['1080p'] >= want['1080p'] && got['720p'] >= want['720p']) return;
    if (!(await confirm(walk, id))) return;
    const embedUrl = `https://play.onestream.today/stream/page/${id}`;
    if (collected.has(embedUrl)) return;
    collected.set(embedUrl, quality);
    if (got[quality] !== undefined) got[quality] += 1;
  });

  const all = [...collected.entries()].map(([u, quality]) => ({ quality, url: u }));
  const preferred = all.filter((e) => PREFERRED.test(e.quality));
  return { kind: 'movie', embeds: preferred.length ? preferred : all.slice(0, 4) };
}

/** Walk any item URL; dispatches on the URL shape. */
export async function walkItem(url, { walk }) {
  return isSeriesUrl(url) ? walkSeries(url, { walk }) : walkMovie(url, { walk });
}
