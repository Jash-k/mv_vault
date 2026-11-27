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
 * Hop chain per series: the same folders, then either a season layer
 * (…-season-01/ → …-season-01-1080p/) or the episode slugs straight on the page.
 *
 * MOVIE vs SERIES IS DECIDED FROM THE PAGE, NOT THE URL. The site lists series
 * under movie-shaped paths all the time:
 *   /ayali-season-01-2023-tamil-movie/  → episodes directly on the page
 *   /aindham-vedham-2024-tamil-movie/   → links to /aindham-vedham-season-01/
 * Walking those as movies finds no 1080p/720p folder, returns "empty", and the
 * title never enters the vault. That was the bug behind the missing A–Z and
 * year-list series. Now: episode slugs or season folders anywhere on the page →
 * series walk.
 *
 * Quality policy (unchanged, user-locked): keep 1080p + 720p; fall back to
 * 360p/other rips ONLY when a film has neither.
 *
 * Hosts: every moviesda domain (moviesda34.com, moviesdatamil.net, moviezda.net)
 * redirects to moviezda.net today, so that is the host we FETCH. What we STORE
 * in pageUrl/state stays on moviesda34.com so existing data and keys never fork.
 */
import * as cheerio from 'cheerio';
import { parseSourceMetadata } from './source-metadata.mjs';

/** The host every domain redirects to today. Change this one line if it moves. */
export const LIVE = String(process.env.MOVIESDA_HOST || 'https://moviesda.ski').replace(/\/$/, '').replace(/^(?!https?:\/\/)/, 'https://');
/** Canonical origin used inside pageUrl + state.json keys. Never rewritten. */
export const CANON = 'https://moviesda34.com';
/** Poster files live on the fetch host. */
export const POSTER_HOST = LIVE;

/**
 * Bump this whenever the walk logic changes. `state.json` stamps every verdict
 * with it, and a verdict written by an older walker is re-tried instead of being
 * trusted — so a fix like "series under movie paths" takes effect on the next
 * pass instead of waiting out a 7-day empty window.
 */
export const WALK_VERSION = 4;

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
export async function getHtml(url, { signal } = {}) {
  let lastError = new Error('not attempted');
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    if (signal?.aborted) throw new Error('metadata request cancelled');
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
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
      if (signal?.aborted) break;
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
export const canonicalUrl = (path, base = CANON) => `${base}${path.startsWith('/') ? path : `/${path}`}`;

/* ---------------------------------------------------------------- isaiDub */
/**
 * The dubbed catalogue (isaidub.green) runs on the same platform and the same
 * ID system as moviesda, but a different subdomain and route:
 *
 *   moviesda : play.onestream.today/stream/page/<id>   (id from downloadpage.xyz)
 *   isaiDub  : dub.onestream.today/stream/video/<id>   (id from dubmv.xyz)
 *
 * The lists look the same (year folder, A–Z letters, /recent-updates/, collections)
 * but the item shape is different, so it gets its own walker. Every ID is verified
 * on the dub player page before it is stored, and that page's <title> is checked
 * against the film's own title — a wrong pairing never reaches the vault.
 */
export const DUB = 'https://isaidub.green';
export const DUB_PLAYER = 'https://dub.onestream.today/stream/video';
const DUB_ITEM_RX = /^\/movie\/(?!\d+\/?$)[^/]+\/$/;                 // /movie/<slug>/ — not the numeric episode pages
const DUB_SKIP_RX = /-collections?\/$|^\/movie\/(?:tamil|hollywood|genres|yearly)/;

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
export function parseListing(html, pageUrl, { base = CANON, dubbed = false, includeCollections = false } = {}) {
  if (looksBlocked(html)) throw new Error(`blocked/challenge document at ${pageUrl}`);
  const $ = cheerio.load(html);
  const out = new Map();
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') || '';
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:')) return;
    let path;
    try { path = new URL(raw, pageUrl).pathname; } catch { return; }
    path = path.replace(/\/+$/, '') + '/';
    const wanted = dubbed ? DUB_ITEM_RX.test(path) && (!DUB_SKIP_RX.test(path) || (includeCollections && /-collections?\/$/.test(path))) : isItemPath(path);
    if (!wanted || out.has(path)) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    out.set(path, {
      path,
      url: canonicalUrl(path, base),
      label,
      // A hint only — the walk decides for real from the page itself.
      kind: /web series|season \d|\bepi\b/i.test(label + path) || /-web-series\//.test(path) || (!dubbed && isSeriesPath(path)) ? 'series' : 'movie',
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
/** Follow source-declared pagination: query pages AND /letter/2 routes. */
export function nextListingUrl(html, currentUrl) {
  const current = new URL(currentUrl);
  const root = current.pathname.replace(/\/\d+\/?$/, '').replace(/\/$/, '');
  const page = Number(current.searchParams.get('page') || current.searchParams.get('get-page') || current.pathname.match(/\/(\d+)\/?$/)?.[1] || 1);
  const $ = cheerio.load(html), candidates = [];
  $('a[href]').each((_, el) => {
    let target;
    try { target = new URL($(el).attr('href'), current); } catch { return; }
    if (!['http:', 'https:'].includes(target.protocol)) return;
    const path = target.pathname.replace(/\/$/, '');
    const targetRoot = path.replace(/\/\d+$/, '');
    if (targetRoot !== root) return;
    const n = Number(target.searchParams.get('page') || target.searchParams.get('get-page') || path.match(/\/(\d+)$/)?.[1] || 1);
    if (n > page) { target.host = current.host; target.protocol = current.protocol; candidates.push([n,target.href]); }
  });
  candidates.sort((a,b)=>a[0]-b[0]);
  return candidates[0]?.[1] || '';
}

export async function discover(path, { param = 'page', maxPages = 40, deadline = 0, log = () => {}, host = LIVE, canonBase = CANON, dubbed = false } = {}) {
  const items = new Map(), seen = new Set();
  let url = `${host}${path}`;
  for (let page = 1; page <= maxPages; page++) {
    if (deadline && Date.now() > deadline) { log(`listing paused by budget: ${path}`); break; }
    let html;
    try { ({ html } = await getHtml(url)); } catch (error) { log(`listing failed: ${path}`); break; }
    const rows = parseListing(html,url,{base:canonBase,dubbed,includeCollections:path.includes('collections')});
    const fingerprint = rows.map(r=>r.path).sort().join('|');
    if (!rows.length || seen.has(fingerprint)) break;
    seen.add(fingerprint);
    for (const row of rows) items.set(row.path,row);
    log(`listing ${path} page ${page}: ${rows.length} items`);
    const next = nextListingUrl(html,url);
    if (!param || !next) break;
    url = next;
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
    const target = new URL(url);
    if (target.origin !== new URL(base).origin || target.pathname.includes('/download/')) return;
    if (target.searchParams.has('page') || target.searchParams.has('get-page')) return;
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
const SEASON_FOLDER_RX = /season[- ]?\d+/i;

/** Episode download links present on a page (the real "this is a series" signal). */
const episodeSlugs = (html, base) => slugLinks(html, base).filter((s) => episodeOf(s.href));

/**
 * Which walker does this page need? Decided from the page, with the URL only as
 * a hint: a series can be published under a movie-shaped path, and those were
 * the titles silently lost.
 */
export function planWalk(html, url) {
  const path = (() => { try { return new URL(url, CANON).pathname; } catch { return url; } })();
  if (/-web-series(?:\/|-)|-season-\d+\/?$/.test(path)) return 'series';
  if (episodeSlugs(html, url).length) return 'series';
  if (folderLinks(html, url).some((l) => SEASON_FOLDER_RX.test(l.href))) return 'series';
  return 'movie';
}

/** The site's own poster <img>, used when a record has no artwork yet. */
export function posterFromHtml(html = '') {
  const text = String(html);
  const img = text.match(/<img[^>]+src=["']([^"']*\/uploads\/posters\/[^"']+)["']/i)?.[1];
  if (img) return new URL(new URL(img, POSTER_HOST).pathname, POSTER_HOST).href;
  const stray = text.match(/\/uploads\/posters\/([^"'\s)]+\.(?:jpe?g|png|webp))/i)?.[1];
  return stray ? `${POSTER_HOST}/uploads/posters/${stray}` : '';
}

export const mapLimit = async (rows, limit, fn) => {
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
async function confirmEmbed(id, onError = () => {}) {
  const url = `https://movies.downloadpage.xyz/download/page/${id}`;
  try {
    const { html } = await getHtml(url);
    return new RegExp(`play\\.onestream\\.today/stream/page/${id}(?![0-9])`).test(html) ? embedUrlOf(id) : '';
  } catch { onError(); return ''; }
}

/**
 * One movie → [{ quality, url }] under the locked quality policy.
 *
 * Variable-depth same-site traversal: at most 16 folder pages including the
 * item, depth 5, 8 slug pages and 10 ID confirmations. Limits/failures mark the
 * result incomplete so a partial walk is never trusted as a complete empty.
 */
export async function walkMovie(url, { deadline = 0, html: prefetched = '' } = {}) {
  const itemHtml = prefetched || (await getHtml(url)).html;
  if (!prefetched && looksBlocked(itemHtml)) throw new Error(`blocked/challenge document for ${url}`);
  const poster = posterFromHtml(itemHtml);
  const origin = new URL(url).origin;

  // Layouts vary: downloads can occur at any level, including the item
  // itself. Explore only relevant same-site folders, with a global page budget.
  const pending = [{ url, html: itemHtml, quality: 'HD', depth: 0 }];
  const visited = new Set();
  const slugMap = new Map();
  const directIds = [];
  let incomplete = false;
  const clean = value => { const u = new URL(value); u.hash = ''; return u.href; };
  while (pending.length) {
    if ((deadline && Date.now() >= deadline) || visited.size >= 16) { incomplete = true; break; }
    pending.sort((a,b) => rank(a.quality) - rank(b.quality) || a.depth - b.depth);
    const page = pending.shift();
    const key = clean(page.url);
    if (visited.has(key)) continue;
    visited.add(key);
    let html = page.html;
    if (!html) {
      await paced();
      try { html = (await getHtml(page.url)).html; }
      catch { incomplete = true; continue; }
    }
    if (looksBlocked(html)) { incomplete = true; continue; }
    for (const id of fileIds(html)) directIds.push({id, quality:page.quality});
    for (const slug of slugLinks(html, page.url)) {
      if (/sample|trailer|teaser/i.test(slug.href + ' ' + slug.label)) continue;
      const key = clean(slug.url);
      if (!slugMap.has(key) || rank(page.quality) < rank(slugMap.get(key).quality))
        slugMap.set(key, {...slug, url:key, quality:page.quality});
    }
    const children = folderLinks(html, page.url).filter(child => {
      const target = new URL(child.url);
      if (target.origin !== origin || target.search || NAV_RX.test(target.pathname)) return false;
      if (/sample|trailer|teaser/i.test(child.href + ' ' + child.label)) return false;
      if (/^\/(?:index\.php|disclaimer|privacy|contact|about|dmca)\/?$/i.test(target.pathname)) return false;
      return !visited.has(clean(child.url));
    });
    const preferred = children.filter(c => PREFERRED.test(c.quality));
    const selected = preferred.length ? children.filter(c=>PREFERRED.test(c.quality)||c.quality==='HD') : children;
    for (const child of selected) {
      if (page.depth >= 5) { incomplete = true; continue; }
      if (!pending.some(p=>clean(p.url)===clean(child.url))) pending.push({...child, quality:child.quality==='HD'?page.quality:child.quality,depth:page.depth+1});
    }
  }
  const sortedSlugs = [...slugMap.values()].sort((a,b)=>rank(a.quality)-rank(b.quality));
  if (sortedSlugs.length > 8) incomplete = true;
  const slugRows = sortedSlugs.slice(0,8);

  // 3. slug pages → numeric file ids (1 per slug, in parallel)
  const idRows = (await mapLimit(slugRows, 3, async (slug) => {
    try {
      if (deadline && Date.now() >= deadline) { incomplete = true; return []; }
      const { html } = await getHtml(slug.url);
      if (looksBlocked(html)) { incomplete = true; return []; }
      return fileIds(html).slice(0, 1).map((id) => ({ id, quality: slug.quality }));
    } catch { incomplete = true; return []; }
  })).flat();

  // 4. confirm ids, highest quality first, and stop once enough are live
  const unique = new Map();
  for (const row of [...directIds, ...idRows]) if (!unique.has(row.id)) unique.set(row.id, row.quality);
  const candidates = [...unique.entries()].map(([id, quality]) => ({ id, quality }))
    .sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, 10);

  const collected = new Map(); // url → quality
  const got = { '1080p': 0, '720p': 0 };
  await mapLimit(candidates, 4, async ({ id, quality }) => {
    if (got['1080p'] >= 4 && got['720p'] >= 4) return;
    if (deadline && Date.now() >= deadline) { incomplete = true; return; }
    const embed = await confirmEmbed(id, () => { incomplete = true; });
    if (embed && !collected.has(embed)) {
      collected.set(embed, quality);
      if (got[quality] !== undefined) got[quality] += 1;
    }
  });

  const all = [...collected.entries()].map(([u, quality]) => ({ quality, url: u }));
  const preferred = all.filter((e) => /^(1080p|720p)$/i.test(e.quality));
  return { kind: 'movie', embeds: preferred.length ? preferred : all.slice(0, 4), poster, ...(incomplete ? {incomplete:true} : {}) };
}

/**
 * One web series → { seasons:[…], embeds:[…] } with season+episode on the flat list.
 *
 * Two real shapes, both handled:
 *   with quality layer: item → *-season-01/ → *-season-01-1080p/ → /download/…-epi-NN/
 *   flat (very common):  item → /download/…-season-01-epi-NN/ straight on the page
 * The flat shape has no quality token at all, so those episodes are stored as
 * 'HD' (the same convention already used in the vault) — never dropped.
 */
export async function walkSeries(url, { deadline = 0, html: prefetched = '', maxEpisodePages = 50 } = {}) {
  const checkBudget = () => {
    if (deadline && Date.now() >= deadline) throw new Error('series walk paused by budget; retry required');
  };
  checkBudget();
  const itemHtml = prefetched || (await getHtml(url)).html;
  if (looksBlocked(itemHtml)) throw new Error(`blocked/challenge document for ${url}`);
  const poster = posterFromHtml(itemHtml);
  const jobs = new Map();
  let incomplete = false;
  const visitedFolders = new Set();

  // Pagination belongs to this exact folder, never to a different season/show.
  // Read every linked page; never guess page numbers or treat ?page=2 as a folder.
  async function pages(folderUrl, firstHtml) {
    const pending = [folderUrl];
    const seen = new Set();
    const result = [];
    while (pending.length) {
      if (deadline && Date.now() >= deadline) { incomplete = true; break; }
      const pageUrl = pending.shift();
      if (seen.has(pageUrl)) continue;
      if (seen.size >= maxEpisodePages) { incomplete = true; break; }
      seen.add(pageUrl);
      let html;
      try { html = pageUrl === folderUrl && firstHtml ? firstHtml : (await getHtml(pageUrl)).html; }
      catch { incomplete = true; continue; }
      if (looksBlocked(html)) { incomplete = true; continue; }
      result.push({ html, url: pageUrl });
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        const href = absolute(pageUrl, $(a).attr('href'));
        if (!href) return;
        const next = new URL(href); const base = new URL(folderUrl);
        if (next.origin !== base.origin || next.pathname !== base.pathname) return;
        const page = next.searchParams.get('page') || next.searchParams.get('get-page');
        if (!/^[1-9]\d*$/.test(page || '')) return;
        next.hash = '';
        if (Number(page) === 1) next.search = base.search;
        if (!seen.has(next.href) && !pending.includes(next.href)) pending.push(next.href);
      });
    }
    return result;
  }

  async function visit(folderUrl, firstHtml, qualityHint = 'HD', seasonHint = 1, depth = 0) {
    if (deadline && Date.now() >= deadline) { incomplete = true; return; }
    if (visitedFolders.has(folderUrl)) return;
    if (visitedFolders.size >= 80) { incomplete = true; return; }
    visitedFolders.add(folderUrl);
    const children = new Map();
    for (const page of await pages(folderUrl, firstHtml)) {
      for (const slug of episodeSlugs(page.html, page.url)) {
        const declared = /(1080p|720p|480p|360p)/i.test(`${slug.label} ${slug.href}`);
        jobs.set(slug.url, {
          slugUrl: slug.url,
          quality: declared ? qualityOf(slug.label, slug.href) : qualityHint,
          season: seasonOf(slug.href) || seasonHint,
          episode: episodeOf(slug.href),
        });
      }
      for (const link of folderLinks(page.html, page.url)) {
        if (new URL(link.url).pathname === new URL(folderUrl).pathname) continue;
        if (depth === 0 ? SEASON_FOLDER_RX.test(link.href) || /\d{3,4}p/i.test(link.href) : /\d{3,4}p/i.test(link.href)) children.set(link.url, link);
      }
    }
    if (depth >= 2) return;
    for (const child of children.values()) {
      await visit(child.url, '', child.quality === 'HD' ? qualityHint : child.quality, seasonOf(child.href) || seasonHint, depth + 1);
    }
  }
  await visit(url, itemHtml, 'HD', seasonOf(url) || 1);

  // Confirm per episode, not after every slug has been fetched. A bounded
  // partial walk must retain the episodes already confirmed before its deadline.
  const confirmed = (await mapLimit([...jobs.values()], 3, async job => {
    if (deadline && Date.now() >= deadline) { incomplete = true; return []; }
    try {
      const { html } = await getHtml(job.slugUrl);
      const id = fileIds(html)[0];
      if (!id) { incomplete = true; return []; }
      if (deadline && Date.now() >= deadline) { incomplete = true; return []; }
      const embed = await confirmEmbed(id);
      if (!embed) incomplete = true;
      return embed ? [{ row: { id, ...job }, embed }] : [];
    } catch { incomplete = true; return []; }
  })).flat();
  if (deadline && Date.now() >= deadline) incomplete = true;

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
  return { kind: 'series', seasons: seasonList, embeds: flat, poster, incomplete };
}

/**
 * Walk any item page. The item page is fetched ONCE here, then the page itself
 * decides movie or series. If the movie walk finds nothing, the series walk gets
 * one try on the same HTML (a series published under a movie path whose folders
 * only appear after the first hop).
 */
export async function walkItem(url, options = {}) {
  const html = options.html || (await getHtml(url)).html;
  if (!options.html && looksBlocked(html)) throw new Error(`blocked/challenge document for ${url}`);
  const sourceMetadata = parseSourceMetadata(html, url);
  const attach = result => ({ ...result, sourceMetadata });
  if (planWalk(html, url) === 'series') return attach(await walkSeries(url, { ...options, html }));

  const movie = await walkMovie(url, { ...options, html });
  if (embedCount(movie)) return attach(movie);
  const asSeries = await walkSeries(url, { ...options, html });
  const result = embedCount(asSeries) > embedCount(movie) ? asSeries : movie;
  if (movie.incomplete || asSeries.incomplete) result.incomplete = true;
  return attach(result);
}

/** How many embeds a walk result carries. */
/**
 * Is a stored stream link still playable?
 *
 * The site swaps a movie's files when the release changes (PreDVD → Original),
 * which is how a stored link goes dead: the ID still answers, but the page comes
 * back EMPTY. A live one answers with the player page (~12 KB, has <title> and
 * a <source src>).
 *
 *   alive    → real player page
 *   dead     → empty body (0 bytes) or 404/410  — safe to drop
 *   unknown  → 403/429/5xx/timeout/network — NEVER drop anything on this
 *
 * Only 'dead' ever removes a link from the vault.
 */
export async function probeEmbed(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      redirect: 'follow', signal: AbortSignal.timeout(12000) });
    stats.requests += 1;
    if (res.status === 404 || res.status === 410) { await res.body?.cancel(); return { verdict: 'dead', reason: `http ${res.status}` }; }
    if (!res.ok) { await res.body?.cancel(); return { verdict: 'unknown', reason: `http ${res.status}` }; }
    const html = await res.text();
    stats.bytes += html.length;
    if (looksBlocked(html) || /temporar(?:ily|y)|maintenance|service unavailable|just a moment|access denied/i.test(html)) return { verdict: 'unknown', reason: 'challenge-or-maintenance' };
    const player = /<(?:video|source)\b[^>]*\bsrc\s*=|jwplayer\s*\(|new\s+Plyr\s*\(|player\.src\s*\(/i.test(html);
    return player ? { verdict: 'alive', bytes: html.length, note: 'player markup only; playback not tested' }
      : { verdict: 'unknown', bytes: html.length, reason: 'no-confirmed-player-markup' };
  } catch { return { verdict: 'unknown', reason: 'request-failed' }; }
}

/* ---------------------------------------------------------- isaiDub walker */

/** Every link on a dub page, with its label: [{ href, path, url, text }]. */
function dubLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') || '';
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:')) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const url = absolute(pageUrl, raw);
    if (!url || seen.has(url)) return;
    seen.add(url);
    let path = ''; try { path = new URL(url).pathname.replace(/\/+$/, '') + '/'; } catch { /* keep '' */ }
    out.push({ href: raw, path, url, text });
  });
  return out.filter((l) => !/telegram|whatsapp|facebook|twitter|favicon|style\.min|\/contact|\/dmca|^\/$/i.test(l.href + l.text));
}

const dubQuality = (text = '', href = '') => {
  const t = `${text} ${href}`;
  const m = t.match(/(1080p|720p|480p|360p|240p)/i);
  if (m) return m[1].toLowerCase();
  // older titles label quality by resolution: "Mp4 HD (640x360)"
  const r = t.match(/(\d{3,4})\s*[x*\u00d7]\s*(\d{3,4})/i);
  if (r) {
    const h = Number(r[2]);
    return h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 460 ? '480p' : h >= 340 ? '360p' : `${h}p`;
  }
  return '';
};
const dubStageOf = (text = '') => {
  const m = text.match(/\(([^)]+?)\)\s*\[?/);
  if (m && /(original|predvd|pre-dvd|dvd|web-?dl|hq|hdrip|cam)/i.test(m[1])) return m[1].replace(/\s*(?:hd|\+).*$/i, '').trim();
  if (/original/i.test(text)) return 'Original';
  return '';
};
const dubEpisodesIn = (text = '') => Number(text.match(/(?:epi|ep|episode)[- ]?0*(\d+)/i)?.[1] || 0);
const dubSeasonIn = (text = '') => Number(text.match(/season[- ]?0*(\d+)/i)?.[1] || 0);

/** Parse "Hokum (2026) Tamil Dubbed Movie (Original HD) [360p HD + 720p HD]" → title/year/kind. */
export function parseDubLabel(label = '', path = '') {
  let text = String(label).replace(/\s+/g, ' ').trim();
  let isSeries = /web series/i.test(text) || /-web-series\//.test(path) || /season\s*\d/i.test(text);
  let season = dubSeasonIn(text);
  let year = Number((text.match(/\((19|20)\d{2}\)/) || text.match(/\b(19|20)\d{2}\b/) || [])[0]?.replace(/[()]/g, '') || 0);
  // cut everything from "Tamil Dubbed …" / "(Original …)" / "[…]" onwards
  let title = text.split(/\s*\(\s*(?:19|20)\d{2}\s*\)/)[0]
    .replace(/\s*[-(]?\s*tamil\s+dubbed.*$/i, '')
    .replace(/\s+tamil\s*$/i, '')
    .replace(/\s*[\[(].*$/, '')
    .replace(/[\s·-]+$/, '')
    .trim();
  // "Pokemon (1997) Season 18 (Epi 99 …)" → title "Pokemon", season 18, episode 99
  if (!title || !year) {
    // fall back to the slug: /movie/hokum-2026-tamil-dubbed-movie/,
    // /movie/pokemon-1997-season-18-tamil-dubbed-movie/, /movie/2-fast-2-furious-2003-…
    // The LAST year in the slug is the release year (titles like "1971 Raanuvayellai"
    // and "Blade Runner 2049" carry their own).
    const slug = path.replace(/^\/movie\//, '').replace(/\/$/, '');
    const years = [...slug.matchAll(/-(\d{4})(?=-|$)/g)].filter((m) => /^(?:19|20)\d{2}$/.test(m[1]));
    const last = years.at(-1);
    let base = last ? slug.slice(0, last.index) : slug;
    if (!year && last) year = Number(last[1]);
    const rest = last ? slug.slice(last.index + last[0].length) : '';
    const seasonFromSlug = Number(rest.match(/season[- ]?(\d+)/i)?.[1] || 0);
    if (seasonFromSlug) { if (!season) season = seasonFromSlug; isSeries = true; }
    base = base.replace(/-(?:tamil|english|hindi|kannada|telugu|malayalam)-?(?:dubbed)?$|-(?:dubbed|web-series|web|hd|original|collections?)$/gi, '');
    // never throw away a title the listing already gave us — the slug only fills gaps
    if (!title) title = base.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }
  // episodes and seasons belong in seasons[], not in the series title
  if (season || /\b(?:epi|episode)\b/i.test(title)) {
    title = title
      .replace(/\s*[-–:—]?\s*(?:episode|epi)\.?\s*\d+\s*(?:[-–:—].*)?$/i, '')
      .replace(/\s*[-–:]?\s*season\s*\d+\s+(?:e|ep|epi|episode)[- .]?\s*\d+.*$/i, '')
      .replace(/\s*[-–:]?\s*season\s*\d+\s*(?:part\s*\d+)?\s*$/i, '')
      .replace(/\s+tamil(?=\s+(?:season|part)\b|\s*$)/i, ' ')
      .replace(/[\s·-]+$/, '').trim();
  }
  return { title, year, isSeries, season };
}

/** Confirm one dub player id. Returns the playable URL, or '' when it is not live. */
export async function confirmDubEmbed(id, title = '') {
  const url = `${DUB_PLAYER}/${id}`;
  try {
    const { html } = await getHtml(url);
    if (!/<source\s+src|<video|player/i.test(html) || html.length < 400) return '';
    if (title) {
      // the player page carries the film's title — a wrong pairing is rejected
      const shown = (html.match(/<title>([^<]*)/i) || [])[1] || '';
      const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const wanted = norm(title).split(' ').filter((w) => w.length > 3).slice(0, 3);
      if (wanted.length && !wanted.every((w) => norm(shown).includes(w))) return '';
    }
    return url;
  } catch { return ''; }
}

const DUB_WANT = /^\d{3,4}p$/;

/**
 * Collect the /download/page/<id>/ ids behind one isaiDub page. Two shapes exist:
 *   · the page links the download pages itself (older single-quality titles), or
 *   · it links quality folders / episode pages that must be opened first.
 * "Sample" entries are never the film, so they are skipped.
 */
async function dubDownloadIds(pageUrl, html, out, { quality = '720p', episode = 0, depth = 0, deadline = 0 } = {}) {
  const links = dubLinks(html, pageUrl);
  let found = 0;
  for (const l of links) {
    const m = l.path.match(/\/download\/page\/(\d+)\//);
    if (!m || /sample/i.test(l.text)) continue;
    const q = dubQuality(l.text, l.href) || quality;
    const ep = dubEpisodesIn(l.text) || episode;
    if (!out.has(m[1])) out.set(m[1], { quality: q, episode: ep });
    found += 1;
  }
  if (found || depth >= 3) return out;
  const kids = links.filter((l) => /^\/movie\//.test(l.path));
  const ranked = kids.filter((l) => dubQuality(l.text, l.href))
    .sort((a, b) => rank(dubQuality(a.text, a.href)) - rank(dubQuality(b.text, b.href)));
  for (const k of (ranked.length ? ranked : kids).slice(0, 3)) {
    if (deadline && Date.now() > deadline) break;
    let kidHtml;
    try { ({ html: kidHtml } = await getHtml(k.url)); } catch { continue; }
    await dubDownloadIds(k.url, kidHtml, out, {
      quality: dubQuality(k.text, k.href) || quality,
      episode: dubEpisodesIn(k.text) || episode,
      depth: depth + 1, deadline,
    });
    await paced();
  }
  return out;
}

/**
 * Walk one isaiDub title. Two shapes exist:
 *
 *   movie              item → stage          → quality folders → /download/page/<id>/ → dub player
 *   series (web)       item → season folders → quality folders → one /download/page/<id>/ per episode
 *   series (episode)   item (paginated ?get-page=N) → /movie/<n>/ → /movie/<n+1>/ → /download/page/<id>/
 *
 * The season/episode form covers Pokémon-style shows where each episode is its own
 * mini page. Everything is confirmed on the dub player page before it is stored.
 */
export async function walkDubbed(url, { deadline = 0, html: prefetched = '', maxEpisodePages = 100, maxEpisodeItems = 2000, maxSeasons = 100, title = '' } = {}) {
  let incomplete = false;
  if (deadline && Date.now() > deadline) throw new Error('walk budget expired');
  const itemHtml = prefetched || (await getHtml(url)).html;
  if (!prefetched && looksBlocked(itemHtml)) throw new Error(`blocked/challenge document for ${url}`);
  const poster = posterFromHtml(itemHtml);
  const sourceMetadata = parseSourceMetadata(itemHtml, url);
  const rows = dubLinks(itemHtml, url);

  /* ---------- series, episode-list shape: every row is one episode page ---------- */
  const episodeRows = rows.filter((r) => /^\/movie\//.test(r.path) && dubEpisodesIn(r.text));
  if (episodeRows.length) {
    const episodes = new Map();              // path → { season, episode, url, text }
    const addEp = (r) => { if (!episodes.has(r.path)) episodes.set(r.path, { season: dubSeasonIn(r.text) || 0, episode: dubEpisodesIn(r.text), url: r.url, text: r.text }); };
    for (const r of episodeRows) addEp(r);
    // follow the pagination of the item page for the rest of the episodes
    let next = nextListingUrl(itemHtml, url), pages = 1;
    const visited = new Set([url]);
    while (next) {
      if ((deadline && Date.now() > deadline) || pages >= maxEpisodePages || visited.has(next)) { incomplete = true; break; }
      visited.add(next);
      let html;
      try { ({ html } = await getHtml(next)); } catch { incomplete = true; break; }
      for (const r of dubLinks(html, next).filter(x => /^\/movie\//.test(x.path) && dubEpisodesIn(x.text))) addEp(r);
      pages++;
      next = nextListingUrl(html,next);
      await paced();
    }
    const allEpisodes = [...episodes.values()].sort((a,b)=>a.season-b.season || a.episode-b.episode);
    if (allEpisodes.length > maxEpisodeItems) incomplete = true;
    const list = allEpisodes.slice(0,maxEpisodeItems);
    const got = [];
    await mapLimit(list, 3, async (ep) => {
      if (deadline && Date.now() > deadline) { incomplete = true; return; }
      let epHtml;
      try { ({ html: epHtml } = await getHtml(ep.url)); } catch { incomplete = true; return; }
      const ids = new Map();
      await dubDownloadIds(ep.url, epHtml, ids, { quality: '720p', episode: ep.episode, deadline });
      const ordered = [...ids.entries()].sort((a, b) => rank(a[1].quality) - rank(b[1].quality)).slice(0, 2);
      for (const [id, info] of ordered) {
        const playable = await confirmDubEmbed(id, title);
        if (playable) got.push({ season: ep.season, episode: ep.episode, quality: info.quality, url: playable });
      }
    });
    if (!got.length) return { kind: 'series', seasons: [], embeds: [], poster, sourceMetadata, incomplete };
    const fallbackSeason = dubSeasonIn(episodeRows[0].text) || 1;
    const bySeason = new Map();
    for (const g of got) {
      const season = g.season || fallbackSeason;
      if (!bySeason.has(season)) bySeason.set(season, new Map());
      const eps = bySeason.get(season);
      if (!eps.has(g.episode)) eps.set(g.episode, []);
      eps.get(g.episode).push({ quality: g.quality, url: g.url });
    }
    const seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([season, eps]) => ({
      season,
      episodes: [...eps.entries()].sort((a, b) => a[0] - b[0]).map(([episode, embeds]) => ({ episode, embeds })),
    }));
    const flat = seasons.flatMap((s) => s.episodes.flatMap((ep) => ep.embeds.map((e) => ({ ...e, season: s.season, episode: ep.episode }))));
    return { kind: 'series', seasons, embeds: flat, poster, sourceMetadata, incomplete };
  }

  /* ---------- series, season-folder shape: rows are (Season NN) folders ---------- */
  const seasonRows = rows.filter((r) => /^\/movie\//.test(r.path) && dubSeasonIn(r.text));
  if (seasonRows.length) {
    const seasons = [];
    if (seasonRows.length > maxSeasons) incomplete = true;
    for (const seasonRow of seasonRows.slice(0, maxSeasons)) {
      if (deadline && Date.now() > deadline) { incomplete = true; break; }
      const season = dubSeasonIn(seasonRow.text) || seasons.length + 1;
      let seasonHtml;
      try { ({ html: seasonHtml } = await getHtml(seasonRow.url)); } catch { incomplete = true; continue; }
      const ids = new Map();
      await dubDownloadIds(seasonRow.url, seasonHtml, ids, { quality: '720p', episode: 0, deadline });
      const byEpisode = new Map();
      let auto = 0;
      for (const [id, info] of ids) {
        auto += 1;
        const ep = info.episode;
        if (!ep) { incomplete = true; continue; } // Never invent episode numbers from link order.
        if (!byEpisode.has(ep)) byEpisode.set(ep, []);
        byEpisode.get(ep).push({ id, quality: info.quality });
      }
      const episodes = [];
      await mapLimit([...byEpisode.entries()].sort((a, b) => a[0] - b[0]), 3, async ([ep, list]) => {
        const embeds = [];
        for (const { id, quality } of list.sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, 2)) {
          if (deadline && Date.now() > deadline) { incomplete = true; break; }
          if (embeds.some((e) => e.quality === quality)) continue;
          const playable = await confirmDubEmbed(id, title);
          if (playable) embeds.push({ quality, url: playable });
        }
        if (embeds.length) episodes.push({ episode: ep, embeds });
      });
      if (episodes.length) seasons.push({ season, episodes: episodes.sort((a, b) => a.episode - b.episode) });
      await paced();
    }
    const flat = seasons.flatMap((s) => s.episodes.flatMap((ep) => ep.embeds.map((e) => ({ ...e, season: s.season, episode: ep.episode }))));
    return { kind: 'series', seasons, embeds: flat, poster, sourceMetadata, incomplete };
  }

  /* ---------- movie: quality folders sit under a stage folder (Original/…),
     or — older titles — straight on the item page. Either way the /download/page/<id>/
     links hang one or two levels below, and "Sample" rows are skipped. ---------- */
  const movieRows = rows.filter((r) => /^\/movie\//.test(r.path));
  const sources = [
    ...movieRows.filter((r) => dubQuality(r.text, r.href))
      .sort((a, b) => rank(dubQuality(a.text, a.href)) - rank(dubQuality(b.text, b.href))).slice(0, 2),
    ...movieRows.filter((r) => !dubQuality(r.text, r.href)).slice(0, 2),
  ];
  if (!sources.length) return { kind: 'movie', embeds: [], poster, sourceMetadata, incomplete };
  const collected = new Map();               // id → { quality }
  for (const src of sources) {
    if (deadline && Date.now() > deadline) { incomplete = true; break; }
    let srcHtml;
    try { ({ html: srcHtml } = await getHtml(src.url)); } catch { incomplete = true; continue; }
    await dubDownloadIds(src.url, srcHtml, collected, { quality: dubQuality(src.text, src.href) || '720p', episode: 0, deadline });
    if (collected.size >= 4) break;
    await paced();
  }
  const embeds = [];
  const picked = [...collected.entries()].sort((a, b) => rank(a[1].quality) - rank(b[1].quality)).slice(0, 4);
  await mapLimit(picked, 3, async ([id, info]) => {
    const playable = await confirmDubEmbed(id, title);
    if (playable) embeds.push({ quality: info.quality, url: playable });
  });
  const preferred = embeds.filter((e) => /^(1080p|720p)$/i.test(e.quality));
  return { kind: 'movie', embeds: preferred.length ? preferred : embeds, poster, sourceMetadata, incomplete };
}

export const embedCount = (walked) => walked.kind === 'series' 
  ? (walked.seasons || []).reduce((n, s) => n + s.episodes.reduce((a, e) => a + e.embeds.length, 0), 0)
  : (walked.embeds || []).length;
