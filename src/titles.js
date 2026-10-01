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
/**
 * Labels that are BUTTONS, not titles.
 *
 * The site's /tamil-latest-updates/ rail now shows "Download Now" as the link
 * text for EVERY item (verified 2026-10-01). Before this guard, every new
 * arrival discovered from that rail was titled "Download Now" with year 0 —
 * so it slugified to the id `download-now`, and because ALL of them collapsed
 * to that single id the run kept exactly one and silently dropped the rest.
 * A path is always the better anchor.
 */
const GENERIC_LABEL = /^(?:download(?:\s+now|\s+link[s]?|\s+file)?|watch(?:\s+online)?|click\s+here|play(?:\s+now)?|full\s+movie|movie|server\s*\d*|link|file|zip|now|here|get\s+it|start\s+download)$/i;
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

/** A label that is a button or heading rather than a title. */
export const isGenericLabel = (value = '') => GENERIC_LABEL.test(String(value || '').replace(/\s+/g, ' ').trim());

/** True when a label can never become a valid vault record. */
export function isRejected(label, path, { title, year } = {}) {
  if (NOT_AN_ITEM.test(path || '')) return 'section index page';
  const t = String(title || '').trim();
  if (/^\(/.test(t)) return 'title starts with bracket';
  // A button label AND no year anywhere: even the path gave nothing usable, so
  // skip the item instead of minting a record called "download-now".
  if (isGenericLabel(t) && !year) return 'generic label with no year';
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

/**
 * Title + year for a discovered item: listings carry a label, feeds only a path.
 *
 * v2.1.1 — the label is NOT trusted blindly any more. The site's
 * /tamil-latest-updates/ rail now uses "Download Now" as the link text for
 * every item, and those labels used to win: the record for Romanchakam was
 * saved as { id: "download-now", title: "Download Now", year: 0 }, and every
 * other rail-only item collapsed into that same id (silently dropped by the
 * per-run id dedupe). A path is a permanent anchor; a button label is not.
 *
 * Returns { title, year, from } where `from` records which source won —
 * "path" | "label" | "label+path-year" — so a run log can explain itself.
 */
export function titleForEntry(entry = {}) {
  const fromPath = titleFromPath(entry.path);
  const fromLabel = entry.label ? parseTitleYearLike(entry.label) : { title: '', year: 0 };
  const cleaned = cleanTitle(fromLabel.title || entry.title || '', entry.path);
  const labelTitle = String(cleaned.title || fromLabel.title || '').trim();

  // 1. a button, not a title → the path is the only source
  if (!labelTitle || isGenericLabel(labelTitle)) {
    return { title: fromPath.title || labelTitle, year: fromPath.year || cleaned.year || fromLabel.year || 0, from: 'path' };
  }

  // 2. the label carries no year → the path usually has one, and often a fuller title.
  //    (When the label DOES carry a year, it must win: a rail link for
  //    "Sardar 2 (2026)" on a year-less path used to come out as year 0.)
  const labelYear = cleaned.year || fromLabel.year || 0;
  if (!labelYear && fromPath.title) {
    if (fromPath.title.toLowerCase() === labelTitle.toLowerCase()) {
      return { title: labelTitle, year: fromPath.year || 0, from: 'label+path-year' };
    }
    const labelRicher = /[()\[\].:]/.test(labelTitle) || labelTitle.split(' ').length > fromPath.title.split(' ').length;
    if (!labelRicher) return { title: fromPath.title, year: fromPath.year || 0, from: 'path' };
  }
  return { title: labelTitle, year: labelYear, from: 'label' };
}

/** "Raayan (2024)" → { title: 'Raayan', year: 2024 } (local copy: no http import here). */
function parseTitleYearLike(label = '') {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  const year = Number(text.match(/\((19|20)\d{2}\)/)?.[0]?.replace(/[()]/g, '')) || 0;
  const title = text.replace(/\((19|20)\d{2}\)/g, '').replace(/\s+/g, ' ').trim();
  return { title, year };
}
