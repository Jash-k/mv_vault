/**
 * Historic vault scraper.
 *
 * Goal: every Tamil movie on moviesda with its DURABLE onestream embed links.
 * Direct MP4s are deliberately NOT stored — their tokens rot within hours.
 * Onestream numeric embed IDs stay alive long-term, which is what makes the
 * vault a click-and-play catalog.
 *
 * Walk per movie (only embed-bearing hops are followed):
 *   item page → folder group → resolution pages → /download/<id> →
 *   download/file/<id> → download/page/<id> → onestream/stream/page links
 *
 * Quality policy (user-locked): keep 1080p + 720p embeds; fall back to
 * 360p/other rips ONLY when a movie has neither.
 */
import * as cheerio from 'cheerio';
import {
  absolute,
  fetchPage,
  fetchWithRetry,
  parseTitleYear,
  politeDelay,
  sleep,
  slugify,
} from './http.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const NAV_RX = /tamil-\d{4}-movies|dubbed|collection|hd-mobile|isaidub/i;
const NAV_LABEL_RX = /^tamil\s+\d{4}\s+movies$|^tamil\s+dubbed|^tamil\s+movies\s+collections?$|^tamil\s+hd\s+mobile|^tamil\s+movies$|^collections?$/i;

function extractItemLinks(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  $('div.f a, div.folder a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || /tamil-movies\//.test(href)) return;
    if (/web[- ]?series/i.test(href) || /web[- ]?series/i.test(label)) return; // movies only
    if (NAV_RX.test(href) || NAV_LABEL_RX.test(label)) return; // nav/collection junk
    if (/^tamil\s+\d{4}\b/i.test(label) && /movies/i.test(label)) return;
    out.push({ url: absolute(base, href), label, path: href });
  });
  const seen = new Set();
  return out.filter((row) => (seen.has(row.path) ? false : (seen.add(row.path), true)));
}

/**
 * List every movie item page under one letter (follows /page/N/ until a page
 * repeats or comes back empty).
 */
export async function listLetter(letter, { maxPages = 0, onPage = null } = {}) {
  const items = [];
  const seen = new Set();
  for (let page = 1; page <= 400; page += 1) {
    if (maxPages && page > maxPages) break;
    // Canonical pagination is the QUERY form: /tamil-movies/a/?page=N.
    // The /page/N/ path form is broken upstream (serves a duplicate nav
    // page), which used to end the walk after ~2 real pages.
    const path = `/tamil-movies/${letter}/${page > 1 ? `?page=${page}` : ''}`;
    let rows = [];
    try {
      const { html, base } = await fetchPage(path);
      rows = extractItemLinks(html, base);
      if (!rows.length && page > 1) break; // empty page = end of listing
    } catch {
      break; // letter exhausted or network hiccup — stop this letter
    }
    let fresh = 0;
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      items.push(row);
      fresh += 1;
    }
    if (onPage) onPage(letter, page, rows.length, items.length);
    if (!fresh) break; // full repeat = end of listing
    await politeDelay();
  }
  return items;
}

function extractFolderLinks(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  $('div.f a, div.folder a, a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || href === '/' || href.startsWith('#') || href.startsWith('mailto:')) return;
    if (/telegram|t\.me|whatsapp|instagram/i.test(label + href)) return;
    if (href.includes('-movies/') || href.includes('collection') || href.includes('isaidub')) return;
    const hasQuality = /\d+p|hd|predvd|dvd|blu/i.test(label) || /\d+p|hd-|predvd|dvd|blu/i.test(href);
    const singleSegment = href.split('/').filter(Boolean).length === 1;
    if (!hasQuality && !singleSegment) return;
    const abs = absolute(base, href);
    if (abs) out.push({ url: abs, label });
  });
  const seen = new Set();
  return out.filter((row) => (seen.has(row.url) ? false : (seen.add(row.url), true)));
}

/** Collect onestream embed links for one movie. Quality policy applied here. */
export async function scrapeMovieEmbeds(itemUrl, { deadline = Infinity, maxRes = 4, maxSel = 2 } = {}) {
  const embeds = new Map(); // url -> quality
  const push = (quality, url) => {
    if (!url || embeds.has(url)) return;
    embeds.set(url, quality);
  };

  let groups = [];
  try {
    const { html, base } = await fetchPage(itemUrl);
    groups = extractFolderLinks(html, base);
  } catch {
    return [];
  }
  const groupPages = groups.length ? groups.slice(0, 2) : [{ url: itemUrl, label: '' }];

  for (const group of groupPages) {
    if (Date.now() > deadline) break;
    await politeDelay();
    let resolutions = [];
    try {
      const { html, base } = await fetchPage(group.url);
      resolutions = extractFolderLinks(html, base);
    } catch { continue; }

    for (const res of resolutions.slice(0, maxRes)) {
      if (Date.now() > deadline) break;
      await politeDelay();
      const quality = (res.label.match(/(1080p|720p|480p|360p)/i) || ['HD'])[0];

      let selections = [];
      try {
        const { html, base } = await fetchPage(res.url);
        const $ = cheerio.load(html);
        const set = new Set();
        $('a, div.f a, div.folder a').each((_, el) => {
          const href = $(el).attr('href') || '';
          if (href.startsWith('/download/')) set.add(absolute(base, href));
        });
        selections = [...set];
      } catch { continue; }

      for (const selection of selections.slice(0, maxSel)) {
        if (Date.now() > deadline) break;
        await sleep(200);
        try {
          const { html, base } = await fetchPage(selection);
          const $ = cheerio.load(html);
          const fileLinks = [];
          $('a').each((_, el) => {
            const href = $(el).attr('href') || '';
            if (href.includes('moviespage.xyz/download/file/') || href.includes('/download/file/')) {
              fileLinks.push(absolute(base, href));
            }
          });
          for (const fileLink of fileLinks.slice(0, 2)) {
            await sleep(200);
            try {
              const page = await fetchWithRetry(fileLink);
              const $$ = cheerio.load(page);
              const nextHop = $$('a[href*="download/page/"]').first().attr('href');
              const serverPage = nextHop ? absolute(base, nextHop) : fileLink;
              const inner = serverPage === fileLink ? page : await fetchWithRetry(serverPage);
              const $$$ = cheerio.load(inner);
              $$$('a').each((_, el) => {
                const href = $$$(el).attr('href') || '';
                if (/onestream\.today\/stream\/page\//i.test(href)) {
                  push(quality, absolute(serverPage, href));
                }
              });
              // onestream links also appear as plain text/params on some pages
              const inline = inner.match(/https?:\/\/play\.onestream\.today\/stream\/page\/\d+/g);
              if (inline) inline.forEach((u) => push(quality, u));
            } catch { /* dead selection */ }
          }
        } catch { /* dead selection page */ }
      }
    }
  }

  const all = [...embeds.entries()].map(([url, quality]) => ({ quality, url }));
  const preferred = all.filter((e) => /^(1080p|720p)$/i.test(e.quality));
  // User-locked policy: 1080p/720p only — 360p/other rips only when neither exists.
  return preferred.length ? preferred : all.slice(0, 4);
}
