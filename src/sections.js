/**
 * Section registry — every listing on the site that can carry item pages.
 *
 * Why this exists: the historic CLI only ever discovered items under
 * `/tamil-movies/<letter>/`. That is 1 of 9 listings the site publishes, so web
 * series, numeric-titled films (`/12b-2001-movie/`), the 2015–17 back-catalogue
 * and the entire dubbed section were invisible to the walk (see CHANGES.md).
 *
 * Pagination is NOT uniform — this is the trap that makes a naive crawler think
 * a section has two items: the web-series listing uses `?get-page=N`, everything
 * else uses `?page=N`. Repeatedly requesting `?page=2` on the web-series section
 * just serves page 1 again. Each section therefore declares its own param.
 */

const UA_FILTERS = [
  /tamil-movies\/[a-z]\/?$/,        // A–Z letter/index links
  /tamil-atoz-movies/,
  /tamil-web-series-download/,
  /tamil-hd-movies\/?$/,
  /tamil-dubbed-movies\/?$/,
  /tamil-movies-collection/,
  /moviesda-tamil-collections/,
  /tamilrockers-movies\/?$/,
  /tamil-latest-updates/,
  /tamil-\d{4}-movies\/?$/,
  /tamil-hd-movies-download/,
  /tamil-latest/,
  /\/page\/\d+/,
  /\/feed\/?$/,
];

/** Item-page shapes the site publishes. */
const ITEM_RX = /-(?:tamil-)?movie\/$|-tamil-web-series\/$|-tamil-season-\d+\/?$|-tamil-dubbed-movie\/$|-movie-moviesda\/$|-tamil-web-series-moviesda\/$/;

/** A path that is a section index, not an item (e.g. /tamil-2025-movies-tamil-movie/). */
const NOT_AN_ITEM = /^\/tamil-\d{4}-movies/;

/** Which walker a discovered item needs. */
export function kindOfPath(path = '') {
  if (/-web-series\/$/.test(path) || /-tamil-season-\d+\/?$/.test(path)) return 'series';
  return 'movie';
}

export function isItemPath(path = '') {
  return ITEM_RX.test(path) && !NOT_AN_ITEM.test(path);
}

export const SECTIONS = [
  {
    id: 'az', label: 'A–Z letters', param: 'page', letters: true,
    url: (letter) => `/tamil-movies/${letter}/`,
  },
  {
    id: 'year', label: 'Year sections', param: 'page',
    url: (year) => `/tamil-${year}-movies/`,
    // The site publishes year sections back to 2012; earlier years 404 empty.
    years: Array.from({ length: 15 }, (_, i) => 2012 + i),
  },
  {
    id: 'web-series', label: 'Web series', param: 'get-page',
    url: () => '/tamil-web-series-download/',
  },
  { id: 'hd', label: 'HD mobile', param: 'page', url: () => '/tamil-hd-movies/' },
  { id: 'dubbed', label: 'Tamil dubbed', param: 'page', url: () => '/tamil-dubbed-movies/' },
  { id: 'latest', label: 'Latest updates', param: null, url: () => '/tamil-latest-updates/' },
  { id: 'tamilrockers', label: 'Tamilrockers', param: null, url: () => '/tamilrockers-movies/' },
  // These two are INDEXES of actor collections (level-2 listings: /actor-x-movies-collections/).
  // They legitimately yield 0 items — the movies under them are already covered by the
  // year/A–Z sections. They are still fetched (2 cheap requests) so that an item
  // published only there would be caught.
  { id: 'collection', label: 'Actor collections', param: 'page', url: () => '/tamil-movies-collection/', index: true },
  { id: 'collection2', label: 'Moviesda collections', param: null, url: () => '/moviesda-tamil-collections/', index: true },
];

/** Every (section, index) listing URL to walk, e.g. az×26 letters + year×15... */
export function listingTargets({ letters = 'abcdefghijklmnopqrstuvwxyz', years } = {}) {
  const out = [];
  for (const section of SECTIONS) {
    if (section.letters) {
      for (const letter of letters) out.push({ section, key: letter, path: section.url(letter) });
      continue;
    }
    if (section.years) {
      const list = years || section.years;
      for (const year of list) out.push({ section, key: String(year), path: section.url(year) });
      continue;
    }
    out.push({ section, key: section.id, path: section.url() });
  }
  return out;
}

/** Page URL for a listing, honouring the section's own pagination param. */
export function listingPage(basePath, section, page) {
  if (page <= 1 || !section.param) return basePath;
  return `${basePath}${basePath.includes('?') ? '&' : '?'}${section.param}=${page}`;
}

/**
 * Item links in a listing page. `base` is the origin the page actually came from
 * (the site redirects moviesda34.com → moviezda.net), so hrefs resolve correctly.
 */
export function extractItems(html, base) {
  const out = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = match[1];
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue;
    let url;
    try { url = new URL(href, base); } catch { continue; }
    const path = url.pathname;
    if (UA_FILTERS.some((rx) => rx.test(path))) continue;
    if (!isItemPath(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const label = match[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    out.push({ path, label, kind: kindOfPath(path), url: `https://moviesda34.com${path}` });
  }
  return out;
}

/**
 * Walk one section listing until it ends (an empty page, or a page that repeats
 * everything already seen). Returns items across all of its pages.
 */
export async function listSection(section, { walk, maxPages = 0, onPage = null } = {}) {
  const items = [];
  const seen = new Set();
  const basePath = section._path;
  for (let page = 1; page <= 400; page += 1) {
    if (maxPages && page > maxPages) break;
    const url = `https://moviesda34.com${listingPage(basePath, section, page)}`;
    let html;
    try { html = await walk.get(url); } catch { break; }
    const rows = extractItems(html, url);
    let fresh = 0;
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      items.push({ ...row, section: section.id });
      fresh += 1;
    }
    if (onPage) onPage(section, page, rows.length, items.length);
    if (!rows.length && page > 1) break; // empty page = end of listing
    if (!fresh) break; // full repeat = end of listing
  }
  return items;
}

/** Walk every listing in the registry (the full-coverage safety net). */
export async function listAllSections({ walk, maxPages = 0, onSection = null, concurrency = 6 } = {}) {
  const targets = listingTargets();
  const items = new Map();
  const perSection = {};
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      const section = { ...target.section, _path: target.path };
      let found = [];
      try {
        found = await listSection(section, { walk, maxPages });
      } catch { found = []; }
      perSection[target.section.id] = (perSection[target.section.id] || 0) + found.length;
      for (const row of found) if (!items.has(row.path)) items.set(row.path, row);
      if (onSection) onSection(target, found.length, items.size);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return { items: [...items.values()], perSection, listings: targets.length };
}
