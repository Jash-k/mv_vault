import { getHtml, LIVE, looksBlocked } from './scrape.mjs';
import { parseSourceMetadata } from './source-metadata.mjs';
import { lookupContext, noteLookup, hasLookupIssue, withLookupContext } from './lookup-context.mjs';

/** Source metadata only; reuse the page already read by a recent scraper walk. */
export async function sourceEvidence(record) {
  let url;
  try {
    url = new URL(record.pageUrl);
    if (!url.pathname.startsWith('/movie/')) url.host = new URL(LIVE).host;
    const cached = record.sourceMetadata;
    if (cached?.available && cached.sourceUrl &&
      new URL(cached.sourceUrl).pathname === url.pathname &&
      Date.now() - Date.parse(cached.fetchedAt || '') < 7 * 86400_000) return cached;
    const { html } = await getHtml(url.href, { signal: lookupContext()?.signal });
    if (looksBlocked(html)) { noteLookup('source-blocked'); return { available: false, sourceUrl: url.href }; }
    const evidence = parseSourceMetadata(html, url.href);
    if (!evidence.available) noteLookup('source-empty');
    return evidence;
  } catch {
    noteLookup(lookupContext()?.signal.aborted ? 'lookup-timeout' : 'source-unavailable');
    return { available: false, sourceUrl: url?.href || record.pageUrl || '' };
  }
}

async function resolveRecord(record, { sourceCheck = true } = {}) {
  const T = await import('./tmdb.mjs');
  let meta = await T.enrich(record);
  if (!sourceCheck || record.metadataOverride || (record.tmdbId && !record.verifyIds)) return meta;
  // A transient TMDB problem cannot be repaired by fetching an unrelated site.
  if (meta === undefined && hasLookupIssue('tmdb-nokey', 'tmdb-auth', 'tmdb-cooldown',
    'tmdb-network', 'tmdb-http-500', 'tmdb-http-502', 'tmdb-http-503', 'tmdb-http-504',
    'lookup-timeout', 'tmdb-lookup-timeout', 'tmdb-request-budget')) return undefined;

  const evidence = await sourceEvidence(record);
  if (!evidence.available) return undefined;
  const initiallyIncomplete = meta === undefined || Boolean(meta?.searchScope);
  let contradicted = false;
  if (meta && evidence.cast.length) {
    const check = await T.validateCredits(meta, evidence);
    if (check === undefined) return undefined;
    if (check.contradiction) {
      contradicted = true;
      noteLookup('source-credits-conflict', { tmdbId: meta.tmdbId, tmdbType: meta.tmdbType });
      meta = null;
    } else if (evidence.sourceYear && evidence.sourceYear !== record.year && !check.strong) meta = null;
    else if (check.strong) meta = { ...meta, evidence: { sourceUrl: evidence.sourceUrl, ...check } };
  }
  if (meta && !meta.searchScope) return meta;
  if (meta?.searchScope) noteLookup('scoped-search-needs-credits');
  // Both TV and movies get the same corroboration. A TV record is never
  // resolved to a movie even if its source page accidentally lists film credits.
  const fallback = await T.enrichWithEvidence(record, evidence);
  if (fallback?.evidence?.searchScope) {
    // The scoped API query cannot expose same-title works outside that air
    // year. Until reviewed against live TMDB, this is a suggestion, not an ID
    // assignment. A reviewed override is the only way to promote it.
    noteLookup('scoped-match-needs-review', { suggestedTmdbId: fallback.tmdbId,
      suggestedTmdbType: fallback.tmdbType, suggestedTitle: fallback.tmdbTitle,
      suggestedOriginalLanguage: fallback.originalLanguage, evidence: fallback.evidence });
    return null;
  }
  if (fallback) return fallback;
  if (contradicted) noteLookup('source-credits-conflict');
  if (fallback === undefined || initiallyIncomplete) return undefined;
  return null;
}

export async function enrichRecordDetailed(record, options = {}) {
  return withLookupContext(() => resolveRecord(record, options), options);
}

/** Backwards-compatible tri-state interface; the worker uses detailed results. */
export async function enrichRecord(record, options = {}) {
  return (await enrichRecordDetailed(record, options)).meta;
}
