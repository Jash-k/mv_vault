/**
 * Title hygiene for ingested items.
 *
 * Site listing labels are built for humans, not catalogs, e.g.:
 *   "The Ghazi Attack (2017) HD DVDRip"          → The Ghazi Attack / 2017
 *   "Selvi (2016) Tamil HDTV (DVDScr Audio)"     → Selvi / 2016
 *   "96 Movie (2018)"                            → 96 / 2018
 *   "Triples Season 1 (Tamil) (2020)"            → Triples Season 1 / 2020
 *   "2.0 (Enthiran 2) (2019)"                    → 2.0 (Enthiran 2) / 2019   (kept: real subtitle)
 *
 * It also REJECTS labels that are not titles at all (section headings, nav
 * pages, non-Latin headers) — those must never reach the vault, because they
 * slugify to an empty id.
 */
import { slugify } from './http.js';

const LANG = /^(tamil|telugu|hindi|malayalam|kannada|english|tamil dubbed|hindi dubbed)$/i;
const JUNK = /(hd|dvd|web|blu|x264|rip|predvd|cam|1080p|720p|480p|360p|original|proper|uncut|dubbed|hq|ts\b|scr|movie|series|episode)/i;
// Section/nav pages masquerading as items, e.g. /tamil-2025-movies-tamil-movie/
const NOT_AN_ITEM = /^\/tamil-\d{4}-movies/;

const TYPE_SUFFIX = /-(?:tamil-)?web-series$|-tamil-season-\d+$|-tamil-dubbed-movie$|-tamil-movie-moviesda$|-movie-moviesda$|-tamil-movie$|-movie$/;
const LANG_TAIL = /-(?:tamil|telugu|hindi|malayalam|kannada|english|dubbed|hd|hq|original|proper|predvd|dvdrip|hdrip|tvrip|webrip|bluray|1080p|720p|480p|360p)+$/i;
const YEAR_RX = /(19\d{2}|20[0-3]\d)/;

const titleCase = (value) => {
  const text = String(value || '').trim();
  const words = text.split(' ').map((word) => (word.length <= 2 && !/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)));
  const out = words.join(' ');
  // a lone short word IS the title ("hi" → "Hi"), not a filler word
  return words.length === 1 ? out.charAt(0).toUpperCase() + out.slice(1) : out;
};

/** Trailing language/quality tokens in a space-separated label ("… 2024 Tamil"). */
const LABEL_TAIL = /(?:\s+(?:tamil|telugu|hindi|malayalam|kannada|english|dubbed|hd|hq|original|proper|predvd|dvdr|dvdrip|hdrip|tvrip|webrip|bluray|1080p|720p|480p|360p))+$/i;

const stripLabelTail = (value) => {
  let text = String(value || '');
  let previous;
  do { previous = text; text = text.replace(LABEL_TAIL, ''); } while (text !== previous);
  return text.trim();
};

/**
 * Derive { title, year } from a URL path alone.
 *
 * Needed because the delta feeds (sitemap.xml, latest-updates) give a path with
 * no display label. A naive `path.replace(/-/g, ' ')` yields
 * "veyil 2024 tamil dubbed" with year 0 — so strip the type suffix, lift the
 * year out, drop trailing language/quality tokens, then title-case.
 */
export function titleFromPath(path = '') {
  let s = String(path).replace(/^\/+|\/+$/g, '');
  s = s.replace(TYPE_SUFFIX, '');
  // The year is the LAST year-like token: /12-12-1950-2017-movie/ is the 2017 film
  // (the title itself contains 1950). The trailing separator must be a LOOKAHEAD —
  // a consuming `(?:-|$)` swallows the `-` that the next match needs, so a naive
  // global match finds only the first year.
  const matches = [...s.matchAll(new RegExp(`(?:^|-)${YEAR_RX.source}(?=-|$)`, 'g'))];
  const ym = matches.length ? matches[matches.length - 1] : s.match(YEAR_RX);
  const year = ym ? Number(ym[1]) : 0;
  if (ym && ym.index !== undefined) s = s.slice(0, ym.index) + '-' + s.slice(ym.index + ym[0].length);

  // Normalise separators BEFORE stripping: lifting the year leaves a stray
  // separator ("96-movie-"), and the suffix patterns are anchored to `$`.
  s = s.replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  // strip once more: the suffix only becomes trailing after the year is lifted
  // (/96-movie-2018-movie/ → "96-movie" → "96")
  let previous;
  do { previous = s; s = s.replace(TYPE_SUFFIX, ''); } while (s !== previous);
  do { previous = s; s = s.replace(LANG_TAIL, ''); } while (s !== previous);
  const title = titleCase(s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim());
  return { title, year };
}

export function cleanTitle(label = '', path = '') {
  let s = String(label || '').replace(/\s+/g, ' ').trim();
  if (!s) return titleFromPath(path);

  let ym = s.match(/\((19|20)\d{2}\)/);
  let year = ym ? Number(ym[0].replace(/[()]/g, '')) : 0;
  if (ym) s = s.slice(0, ym.index).trim();

  // no parenthesised year: accept a bare one ("1000 Babies 2024 Tamil")
  if (!year) {
    const bare = s.match(new RegExp(`\\s${YEAR_RX.source}(?:\\s|$)`));
    if (bare) {
      year = Number(bare[1]);
      s = `${s.slice(0, bare.index)} ${s.slice(bare.index + bare[0].length)}`.trim();
    }
  }

  // strip trailing junk parentheticals and bare quality tokens
  let prev;
  do {
    prev = s;
    s = s.replace(/\s*\(([^)]*)\)\s*$/, (m, inner) => (LANG.test(inner.trim()) || JUNK.test(inner) ? '' : m)).trim();
  } while (s !== prev);
  do {
    prev = s;
    s = s.replace(/\s*\b(?:hd|dvddrip|dvdrip|hdrip|webrip|web-dl|tvrip|hdtv|dvdscr|predvd|hdts|cam|1080p|720p|480p|360p|x264|bluray|blu-ray|original|movie)\b\s*$/gi, '').trim();
  } while (s !== prev);

  const title = stripLabelTail(s.replace(/\s*[-–]\s*$/, '').trim());
  if (title) return { title, year };
  return titleFromPath(path); // label was pure junk — fall back to the path
}

/** True when a label can never become a valid vault record. */
export function isRejected(label, path, { title, year } = {}) {
  if (NOT_AN_ITEM.test(path || '')) return 'section index page';
  const t = String(title || '').trim();
  if (/^\(/.test(t)) return 'title starts with bracket';
  if (!/[a-z0-9]/i.test(t)) return 'no latin alphanumerics in title';
  if (!slugify(t)) return 'slugifies to an empty id';
  // NB: single-character titles are legitimate ("3", the 2012 Tamil film) —
  // never reject on length.
  return null;
}

/** Normalise one queue entry in place; returns null when the item must be skipped. */
export function normalizeEntry(entry) {
  const { title, year } = cleanTitle(entry.title || entry.label, entry.path);
  const reject = isRejected(entry.title || entry.label, entry.path, { title, year });
  if (reject) return { rejected: reject, title, year };
  return { title, year: year || entry.year || 0 };
}
