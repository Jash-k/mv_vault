/**
 * scrape.mjs — the whole scraper. Two jobs:
 *
 *   1. LISTING  — read a listing page (/tamil-2026-movies/, /tamil-movies/a/, …)
 *                 and return the item pages on it.
 *   2. WALK     — open one item page and return its durable onestream embeds.
 *
 * Hop chain per movie (verified live 2026-10-03):
 *   item page → /<title>-original-movie/ → /<title>-1080p-hd-movie/ →
 *   /download/<slug>/ → download.moviespage.xyz/download/file/<id> →
 *   movies.downloadpage.xyz/download/page/<id> → play.onestream.today/stream/page/<id>
 *
 * Hop chain per series: same, with a season layer and one slug per episode:
 *   item → *-season-NN-* → *-season-NN-<quality>-* → /download/…-epi-NN-…/
 *
 * Quality policy (unchanged, user-locked): keep 1080p + 720p; fall back to
 * 360p/other rips ONLY when a film has neither.
 *
 * Hosts: every moviesda domain (moviesda34.com, moviesdatamil.net, moviezda.net)
 * redirects to moviezda.net today, so that is the host we FETCH. What we STORE
 * in pageUrl/state stays on moviesda34.com so existing data and keys never fork.
 */
import * as cheerio from 'cheerio';

/** The host every domain redirects to today. Change this one line if it moves. */
export const LIVE = 'https://moviezda.net';
/** Canonical origin used inside pageUrl + state.json keys. Never rewritten. */
export const CANON = 'https://moviesda34.com';
/** Poster files live on the fetch host. */
export const POSTER_HOST = LIVE;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);
const TRIES = Number(process.env.TRIES || 3);
const DELAY_MS = Number(process.env.DELAY_MS || 150);

/** Run counters, printed in the summary. */
export const stats = { requests: 0, retries: 0, bytes: 0, failures: 0 };
const reset = () => { stats.requests = 0; stats.retries = 0; stats.bytes = 0; stats.failures = 0; };
reset(); // counters start at zero on import

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const paced = () => sleep(DELAY_MS + Math.floor(Math.random() * 120));

/** fetch + retry. Hard 404 is not retried; 5xx/429/network is. */
export async function getHtml(url) {
  let lastError = new Error('not attempted');
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel();
        const err = new Error(`HTTP ${res.status}`);
        err.retryable = !(res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
        throw err;
      }
      const html = await res.text();
      stats.requests += 1;
      stats.bytes += Buffer.byteLength(html);
      return { html, ms: Date.now() - started };
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === TRIES) break;
      stats.retries += 1;
      await sleep(500 * attempt + Math.floor(Math.random() * 400));
    }
  }
  stats.failures += 1;
  throw new Error(`${lastError.message} (${url})`);
}

/* ------------------------------------------------------------------ listing */

const ITEM_RX = /-(?:tamil-)?movie\/$|-(?:tamil-)?web-series\/$|-movie-moviesda\/$|-(?:tamil-)?web-series-moviesda\/$|-(?:tamil-)?season-\d+\/?$|-(?:tamil-)?movie-\d+\/$|-moviesda(?:-page)?\/$/;
/** Nav / section paths that must never be treated as an item. */
const NAV_RX = /^\/tamil-movies\/[a-z]?\/?$|^\/tamil-\d{4}-movies|^\/tamil-atoz|^\/tamil-web-series-download|^\/tamil-hd-movies|^\/tamil-dubbed-movies|^\/tamil-movies-collection|^\/moviesda-tamil-collections|^\/tamilrockers-movies|^\/tamil-latest-updates|^\/tamil-latest|^\/feed|^\/page\//;

export const isItemPath = (path = '') => ITEM_RX.test(path) && !NAV_RX.test(path);
export const isSeriesPath = (path = '') => /-web-series(?:-moviesda)?\/$|-season-\d+\/?$/.test(path);
export const canonicalUrl = (path) => `${CANON}${path.startsWith('/') ? path : `/${path}`}`;

/**
 * A bot-check / error document instead of the real page. Treating one of these
 * as a listing would silently skip a letter, and treating it as an "empty item"
 * would park a film for a week — so both callers THROW instead.
 */
export const looksBlocked = (html = '') => {
  const head = String(html).slice(0, 4000);
  return /just a moment|verify you are human|checking your browser|access denied|attention required|cf-error|error 10\d\d/i.test(head);
};

/** Item links on a listing page → [{ path, url, label, kind }] (deduped, in page order). */
export function parseListing(html, pageUrl) {
  if (looksBlocked(html)) throw new Error(`blocked/challenge document at ${pageUrl}`);
  const $ = cheerio.load(html);
  const out = new Map();
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') || '';
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:')) return;
    let path;
    try { path = new URL(raw, pageUrl).pathname; } catch { return; }
    path = path.replace(/\/+$/, '') + '/';
    if (!isItemPath(path) || out.has(path)) return;
    out.set(path, {
      path,
      url: canonicalUrl(path),
      label: $(el).text().replace(/\s+/g, ' ').trim(),
      kind: isSeriesPath(path) ? 'series' : 'movie',
    });
  });
  return [...out.values()];
}

/**
 * Walk a listing until it ends. `param` is the pagination query key the section
 * uses ('page' everywhere except the web-series listing, which uses 'get-page').
 * Stops on: empty page, a page that repeats everything already seen, maxPages,
 * or the deadline. Returns every item found.
 */
export async function discover(path, { param = 'page', maxPages = 40, deadline = 0, log = () => {} } = {}) {
  const items = new Map();
  const seenFingerprints = new Set();
  const base = `${LIVE}${path}`;
  for (let page = 1; page <= maxPages; page += 1) {
    if (deadline && Date.now() > deadline) { log(`  · listing ${path} paused by budget at page ${page}`); break; }
    const url = page === 1 || !param ? base : `${base}${base.includes('?') ? '&' : '?'}${param}=${page}`;
    let html;
    try { ({ html } = await getHtml(url)); } catch (error) { log(`  ! listing ${url} — ${error.message}`); break; }
    const rows = parseListing(html, url);
    const fingerprint = rows.map((r) => r.path).sort().join('|');
    if (!rows.length || seenFingerprints.has(fingerprint)) {
      // Page 1 with nothing on it = the folder exists but is still empty
      // (e.g. /tamil-2027-movies/ before the year starts). Not an error.
      log(page > 1 ? `  · listing ${path} ended at page ${page}` : `  · listing ${path} has no items yet`);
      break;
    }
    seenFingerprints.add(fingerprint);
    let fresh = 0;
    for (const row of rows) if (!items.has(row.path)) { items.set(row.path, row); fresh += 1; }
    log(`  · listing ${path} page ${page}: ${rows.length} items (${fresh} new)`);
    if (!fresh) break;
    await paced();
  }
  return [...items.values()];
}

/* --------------------------------------------------------------------- walk */

const PREFERRED = /^(1080p|720p)$/i;
const rank = (q) => (q === '1080p' ? 0 : q === '720p' ? 1 : q === '480p' ? 2 : q === '360p' ? 3 : 4);
const qualityOf = (label = '', href = '') => {
  const m = `${label} ${href}`.match(/(1080p|720p|480p|360p)/i);
  return m ? m[1].toLowerCase() : 'HD';
};
const absolute = (base, href) => { try { return new URL(href, base).href; } catch { return ''; } };

/** Folder / resolution links on a page, with quality inferred. */
function folderLinks(html, base) {
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
    out.push({ url, href, label, quality: qualityOf(label, href) });
  });
  return out;
}

/** /download/<slug>/ links (the layer that carries "epi-NN" for series). */
function slugLinks(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('/download/') || href.includes('/download/file/') || href.includes('/download/page/')) return;
    const url = absolute(base, href);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, href, label: $(el).text().replace(/\s+/g, ' ').trim() });
  });
  return out;
}

const fileIds = (html) => [...new Set([...String(html).matchAll(/\/download\/file\/(\d+)/g)].map((m) => m[1]))];
const embedUrlOf = (id) => `https://play.onestream.today/stream/page/${id}`;
const seasonOf = (s = '') => Number(String(s).match(/season[- ]?0*(\d+)/i)?.[1] || 0);
const episodeOf = (s = '') => Number(String(s).match(/(?:epi|ep|episode)[- ]?0*(\d+)/i)?.[1] || 0);

/** The site's own poster <img>, used when a record has no artwork yet. */
export function posterFromHtml(html = '') {
  const text = String(html);
  const img = text.match(/<img[^>]+src=["']([^"']*\/uploads\/posters\/[^"']+)["']/i)?.[1];
  if (img) return new URL(new URL(img, POSTER_HOST).pathname, POSTER_HOST).href;
  const stray = text.match(/\/uploads\/posters\/([^"'\s)]+\.(?:jpe?g|png|webp))/i)?.[1];
  return stray ? `${POSTER_HOST}/uploads/posters/${stray}` : '';
}

const mapLimit = async (rows, limit, fn) => {
  const out = new Array(rows.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (i < rows.length) { const idx = i++; out[idx] = await fn(rows[idx], idx); }
  }));
  return out;
};

/**
 * Confirm a numeric file id is live and return its embed URL (or '').
 * The confirm page must reference its OWN id — that is what makes the link
 * durable, instead of trusting whatever the previous hop happened to link to.
 */
async function confirmEmbed(id, { track } = {}) {
  const url = `https://movies.downloadpage.xyz/download/page/${id}`;
  try {
    const { html } = await getHtml(url);
    track?.(url);
    return new RegExp(`play\\.onestream\\.today/stream/page/${id}(?![0-9])`).test(html) ? embedUrlOf(id) : '';
  } catch { track?.(url); return ''; }
}

/**
 * One movie → [{ quality, url }] under the locked quality policy.
 *
 * Request budget per movie is deliberately bounded: at most 3 group folders,
 * 4 resolution pages, 8 slug pages (total, not per resolution) and 10 id
 * confirmations — the same envelope the old pipeline used, which is what keeps
 * a full A–Z pass inside its budget.
 */
export async function walkMovie(url, { deadline = 0, log = () => {} } = {}) {
  const { html: itemHtml } = await getHtml(url);
  if (looksBlocked(itemHtml)) throw new Error(`blocked/challenge document for ${url}`);
  const poster = posterFromHtml(itemHtml);
  const origin = new URL(url).origin;

  const groups = folderLinks(itemHtml, origin);
  // No folders at all = the title is listed but nothing is uploaded yet (the
  // site serves an empty template). One request and out — do not re-fetch the
  // same page hoping for something else.
  if (!groups.length) return { kind: 'movie', embeds: [], poster };
  const preferredGroups = groups.filter((g) => PREFERRED.test(g.quality));
  const useGroups = (preferredGroups.length ? preferredGroups : groups)
    .sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, 3);

  // 1. group folders → resolution pages (a few requests, done sequentially)
  const resolutions = [];
  for (const group of useGroups) {
    if (deadline && Date.now() > deadline) break;
    await paced();
    try {
      const { html } = await getHtml(group.url);
      for (const r of folderLinks(html, new URL(group.url).origin)) {
        resolutions.push({ ...r, quality: r.quality === 'HD' ? group.quality : r.quality });
      }
    } catch { /* group page gone */ }
  }
  if (!resolutions.length) return { kind: 'movie', embeds: [], poster };
  const preferredRes = resolutions.filter((r) => PREFERRED.test(r.quality));
  const useRes = (preferredRes.length ? preferredRes : resolutions)
    .sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, 4);

  // 2. resolution pages → /download/<slug>/ links (8 in total, in parallel)
  const slugRows = (await mapLimit(useRes, 3, async (res) => {
    try {
      const { html } = await getHtml(res.url);
      return slugLinks(html, new URL(res.url).origin).map((s) => ({ ...s, quality: res.quality }));
    } catch { return []; }
  })).flat().slice(0, 8);

  // 3. slug pages → numeric file ids (1 per slug, in parallel)
  const idRows = (await mapLimit(slugRows, 3, async (slug) => {
    try {
      const { html } = await getHtml(slug.url);
      return fileIds(html).slice(0, 1).map((id) => ({ id, quality: slug.quality }));
    } catch { return []; }
  })).flat();

  // 4. confirm ids, highest quality first, and stop once enough are live
  const unique = new Map();
  for (const row of idRows) if (!unique.has(row.id)) unique.set(row.id, row.quality);
  const candidates = [...unique.entries()].map(([id, quality]) => ({ id, quality }))
    .sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, 10);

  const collected = new Map(); // url → quality
  const got = { '1080p': 0, '720p': 0 };
  await mapLimit(candidates, 4, async ({ id, quality }) => {
    if (got['1080p'] >= 4 && got['720p'] >= 4) return;
    const embed = await confirmEmbed(id);
    if (embed && !collected.has(embed)) {
      collected.set(embed, quality);
      if (got[quality] !== undefined) got[quality] += 1;
    }
  });

  const all = [...collected.entries()].map(([u, quality]) => ({ quality, url: u }));
  const preferred = all.filter((e) => /^(1080p|720p)$/i.test(e.quality));
  return { kind: 'movie', embeds: preferred.length ? preferred : all.slice(0, 4), poster };
}

/**
 * One web series → { seasons:[…], embeds:[…] } with season+episode on the flat list.
 *
 * Series have one slug page per episode, so the episode slugs are fetched three
 * at a time instead of one after another — a 10-episode season is ~25 requests
 * either way, but it finishes in a third of the wall-clock time.
 */
export async function walkSeries(url, { deadline = 0, log = () => {} } = {}) {
  const { html: itemHtml } = await getHtml(url);
  if (looksBlocked(itemHtml)) throw new Error(`blocked/challenge document for ${url}`);
  const poster = posterFromHtml(itemHtml);
  const origin = new URL(url).origin;

  const itemLinks = folderLinks(itemHtml, origin);
  const seasonFolders = itemLinks.filter((l) => /season[- ]?\d+/i.test(l.href));

  /** Quality folders of one season → one job per episode slug. */
  const jobs = []; // { slugUrl, quality, season, episode }
  const collect = async (qualityFolders, seasonNo) => {
    qualityFolders.sort((a, b) => rank(a.quality) - rank(b.quality));
    for (const qf of qualityFolders) {
      if (deadline && Date.now() > deadline) break;
      await paced();
      let qfHtml = '';
      try { ({ html: qfHtml } = await getHtml(qf.url)); } catch { continue; }
      for (const slug of slugLinks(qfHtml, new URL(qf.url).origin)) {
        const episode = episodeOf(slug.href);
        if (!episode) continue;
        // The 720p folder's slugs carry no quality token — inherit the folder's.
        const declared = /(1080p|720p|480p|360p)/i.test(`${slug.label} ${slug.href}`);
        jobs.push({ slugUrl: slug.url, quality: declared ? qualityOf(slug.label, slug.href) : qf.quality, season: seasonNo, episode });
      }
    }
  };

  if (seasonFolders.length) {
    // 1a. item → season pages → quality folders
    for (const seasonFolder of seasonFolders) {
      if (deadline && Date.now() > deadline) break;
      const seasonNo = seasonOf(seasonFolder.href) || 1;
      await paced();
      let seasonHtml = '';
      try { ({ html: seasonHtml } = await getHtml(seasonFolder.url)); } catch { continue; }
      let qualityFolders = folderLinks(seasonHtml, new URL(seasonFolder.url).origin)
        .filter((l) => /\d{3,4}p/i.test(l.href) || PREFERRED.test(l.quality));
      if (!qualityFolders.length) qualityFolders = [seasonFolder];
      await collect(qualityFolders, seasonNo);
    }
  } else {
    // 1b. no season layer: some shows put the quality folders straight on the
    //     item page. Use what we already parsed — no second fetch.
    const direct = itemLinks.filter((l) => /\d{3,4}p/i.test(l.href) || PREFERRED.test(l.quality));
    if (!direct.length) return { kind: 'series', seasons: [], embeds: [], poster }; // listed but nothing uploaded yet
    await collect(direct, 1);
  }

  // 2. each episode slug page → the numeric file id (parallel, order preserved)
  const idRows = (await mapLimit(jobs, 3, async (job) => {
    try {
      const { html } = await getHtml(job.slugUrl);
      return fileIds(html).slice(0, 1).map((id) => ({ id, ...job }));
    } catch { return []; }
  })).flat();

  // 3. confirm each id (parallel) → embed
  const confirmed = await mapLimit(idRows, 4, async (row) => ({ row, embed: await confirmEmbed(row.id) }));

  const seasons = new Map(); // season → Map(episode → Map(url → quality))
  for (const { row, embed } of confirmed) {
    if (!embed) continue;
    if (!seasons.has(row.season)) seasons.set(row.season, new Map());
    const eps = seasons.get(row.season);
    if (!eps.has(row.episode)) eps.set(row.episode, new Map());
    const slot = eps.get(row.episode);
    if (![...slot.values()].includes(embed)) slot.set(row.quality, embed);
  }

  const seasonList = [];
  const flat = [];
  for (const [season, eps] of [...seasons.entries()].sort((a, b) => a[0] - b[0])) {
    const episodes = [];
    for (const [episode, embeds] of [...eps.entries()].sort((a, b) => a[0] - b[0])) {
      const list = [...embeds.entries()].map(([quality, u]) => ({ quality, url: u }))
        .sort((a, b) => rank(a.quality) - rank(b.quality));
      const preferred = list.filter((e) => PREFERRED.test(e.quality));
      const kept = preferred.length ? preferred : list;
      episodes.push({ episode, embeds: kept });
      for (const e of kept) flat.push({ quality: e.quality, url: e.url, season, episode });
    }
    if (episodes.length) seasonList.push({ season, episodes });
  }
  return { kind: 'series', seasons: seasonList, embeds: flat, poster };
}

/** Walk any item page; dispatches on the URL shape. */
export const walkItem = (url, options) => (isSeriesPath(new URL(url, CANON).pathname) ? walkSeries(url, options) : walkMovie(url, options));

/** How many embeds a walk result carries. */
export const embedCount = (walked) => walked.kind === 'series'
  ? (walked.seasons || []).reduce((n, s) => n + s.episodes.reduce((a, e) => a + e.embeds.length, 0), 0)
  : (walked.embeds || []).length;
