import * as cheerio from 'cheerio';
import { getHtml, LIVE, looksBlocked } from './scrape.mjs';

/** Source-page metadata only: no players, downloads, or inferred original language. */
export async function sourceEvidence(record) {
  let url;
  try {
    url = new URL(record.pageUrl);
    if (!url.pathname.startsWith('/movie/')) url.host = new URL(LIVE).host;
    const { html } = await getHtml(url.href);
    if (looksBlocked(html)) return { available: false, sourceUrl: url.href };
    const $ = cheerio.load(html);
    const fields = {};
    $('li').each((_, el) => {
      const key = $(el).find('strong').first().text().replace(/:$/, '').toLowerCase().trim();
      const value = $(el).find('span').first().text().trim();
      if (key && value) fields[key] = value;
    });
    const heading = fields.movie || $('h1').first().text() || $('title').text();
    const year = Number(heading.match(/\((19\d{2}|20\d{2})\)/)?.[1] || 0);
    const split = (s) => String(s || '').split(/,|\s+and\s+/).map(s=>s.trim()).filter(s=>s && !/^(N\/A|unknown|none|not available)$/i.test(s));
    return { available: true, sourceUrl: url.href, sourceTitle: heading.trim(), sourceYear: year,
      directors: split(fields.director), cast: split(fields.starring || fields.actors || fields.stars).slice(0,8) };
  } catch { return { available: false, sourceUrl: url?.href || record.pageUrl || '' }; }
}

/** Shared pipeline for daily enrichment and repeatable full backfills. */
export async function enrichRecord(record, { sourceCheck = true } = {}) {
  const T = await import('./tmdb.mjs');
  let meta = await T.enrich(record);
  if (!sourceCheck || (record.tmdbId && !record.verifyIds) || record.kind === 'series' || /series$/.test(record.category || '')) return meta;
  const evidence = await sourceEvidence(record);
  if (!evidence.available) return undefined; // cannot cross-check, not a TMDB miss
  if (meta && evidence.cast.length && meta.tmdbType === 'movie') {
    const check = await T.validateCredits(meta, evidence);
    if (check === undefined) return undefined;
    if (check.contradiction || (evidence.sourceYear && evidence.sourceYear !== record.year && !check.strong)) meta = null;
    else if (check.strong) meta = { ...meta, evidence: { sourceUrl: evidence.sourceUrl, ...check } };
  }
  if (meta === undefined) return undefined;
  if (meta) return meta;
  return T.enrichWithEvidence(record, evidence);
}
