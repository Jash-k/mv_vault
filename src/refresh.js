/**
 * src/refresh.js — keep ALREADY-STORED records current (the "site updated it" path).
 *
 * v2.0 only ever looked at new arrivals, empty pages and due retries, so a
 * record that was once written was never looked at again. That is how Sardar 2
 * ended up with three embed links that serve an empty page while the site had
 * re-uploaded the film with four new ids: `dueForRetry()` skips anything the
 * vault already has, so nothing would ever notice.
 *
 * Two passes, cheapest first:
 *
 *   1. LIVENESS SWEEP — one request per embed. A slice of the catalogue is
 *      checked every night (least-recently-verified first), so the whole vault
 *      is re-verified on a rolling basis for a few minutes of work.
 *   2. REFRESH — only the records that actually have a confirmed-dead embed are
 *      re-walked (pageUrl first, then any config/page-aliases page). New links
 *      are unioned in, dead ones pruned. If a record loses everything it is
 *      left intact and reported instead, so a bad night can never empty the
 *      catalogue.
 */
import { sweepEmbeds } from './liveness.js';
import { upsertRecord, recordFromWalk, planLiveness } from './store.js';
import { walkItem, isSeriesUrl } from './walk.js';

/** Every page URL that describes this record: its own, plus alias pages. */
export function resolvePageUrls(record, pageAliases = {}) {
  const aliases = Object.entries(pageAliases.mergeInto || {})
    .filter(([, id]) => id === record.id)
    .map(([path]) => `https://moviesda34.com${path}`);
  return [...new Set([record.pageUrl, ...aliases].filter(Boolean))];
}

/**
 * Prune CONFIRMED-dead embeds from a record, flat list and seasons tree alike
 * (verify.js asserts the two agree, and that every episode has an embed).
 *
 * Refuses to empty a record: if nothing would remain, nothing is changed and
 * `keptAll` says so — a record with only dead links is still better than a
 * record with no links, and the caller schedules a retry instead.
 */
export function pruneDeadEmbeds(record, deadUrls = []) {
  const dead = new Set(deadUrls);
  if (!dead.size) return { pruned: 0, keptAll: false, remaining: (record.embeds || []).length };
  // embeds are { quality, url } — but a repair may be handed a legacy flat list
  // of url strings, and getting that wrong would silently prune nothing.
  const urlOf = (e) => (typeof e === 'string' ? e : e?.url);
  const remaining = (record.embeds || []).filter((e) => !dead.has(urlOf(e)));
  if (!remaining.length) return { pruned: 0, keptAll: true, remaining: (record.embeds || []).length };

  const before = record.embeds.length;
  record.embeds = remaining;
  record.updatedAt = new Date().toISOString();
  if (Array.isArray(record.seasons)) {
    for (const season of record.seasons) {
      for (const episode of season.episodes) episode.embeds = (episode.embeds || []).filter((e) => !dead.has(urlOf(e)));
      // an episode with no live link left is not an episode
      season.episodes = season.episodes.filter((e) => e.embeds.length);
    }
    record.seasons = record.seasons.filter((s) => s.episodes.length);
  }
  return { pruned: before - remaining.length, keptAll: false, remaining: remaining.length };
}

/**
 * Re-walk a record, trying its own page and then any alias page.
 * `walkPage` is the walker seam (tests inject a stub instead of the network).
 */
export async function refreshRecord(record, { walk, pageAliases = {}, walkPage = walkItem } = {}) {
  const tried = [];
  for (const url of resolvePageUrls(record, pageAliases)) {
    try {
      const walked = await walkPage(url, { walk });
      const embeds = walked.embeds?.length || (walked.seasons || []).reduce((n, s) => n + (s.episodes || []).reduce((a, ep) => a + (ep.embeds || []).length, 0), 0);
      tried.push({ url, embeds, partial: walked.partial === true });
      if (embeds) return { url, walked, tried };
    } catch (error) {
      tried.push({ url, error: error.message });
    }
  }
  return { url: null, walked: null, tried };
}

/**
 * The nightly maintenance pass.
 *
 * @returns { checked, live, dead, unknown, refreshed, pruned, stuck, records }
 */
export async function runMaintenance({
  vault, walk, liveness = {}, pageAliases = {}, limit = 0, refreshLimit = 40, onProgress = null, onlyIds = null, walkPage,
  deadline = 0,
}) {
  const stats = { records: 0, checked: 0, live: 0, dead: 0, unknown: 0, refreshed: 0, pruned: 0, stuck: [] };
  if (!limit) return stats;

  // 1. which records, and every embed url among them (deduped across records)
  const { chosen } = planLiveness(vault, liveness, { limit, onlyIds });
  stats.records = chosen.length;
  if (!chosen.length) return stats;

  const urls = [...new Set(chosen.flatMap(({ record }) => (record.embeds || []).map((e) => e.url)))];
  const sweep = await sweepEmbeds(urls, { deadline });
  stats.checked = sweep.checked;
  stats.live = sweep.live;
  stats.unknown = sweep.unknown;
  const deadOf = new Map(sweep.results.filter((r) => r.state === 'dead').map((r) => [r.url, r]));

  const now = new Date().toISOString();
  const needRefresh = [];

  // 2. timestamp what was actually checked, and collect the records that lost a
  //    link. A record the budget cut short keeps its old timestamp, so the next
  //    run picks it up again instead of it being silently skipped for a week.
  const checked = new Set(sweep.results.map((r) => r.url));
  for (const { record } of chosen) {
    const embeds = record.embeds || [];
    if (embeds.some((e) => !checked.has(e.url))) continue;
    const dead = embeds.filter((e) => deadOf.has(e.url));
    const unknown = embeds.filter((e) => sweep.results.find((r) => r.url === e.url)?.state === 'unknown');
    liveness[record.id] = {
      at: now,
      live: embeds.length - dead.length - unknown.length,
      dead: dead.length,
      unknown: unknown.length,
    };
    if (dead.length) needRefresh.push({ record, dead: dead.map((e) => e.url) });
  }
  stats.dead = needRefresh.reduce((n, r) => n + r.dead.length, 0);

  // 3. refresh the records that need it — newest links in, confirmed-dead links out
  const work = refreshLimit ? needRefresh.slice(0, refreshLimit) : needRefresh;
  let budgetHit = false;
  for (const { record, dead } of work) {
    if (deadline && Date.now() > deadline) {
      budgetHit = true;
      stats.stuck.push({ id: record.id, url: record.pageUrl, kind: record.kind || 'movie', reason: `dead links, refresh deferred (${dead.length}) — run out of budget` });
      continue;
    }
    const result = await refreshRecord(record, { walk, pageAliases, walkPage });
    onProgress?.(record, result);
    if (result.walked) {
      const series = record.kind === 'series' || isSeriesUrl(result.url);
      const entry = { url: result.url, path: new URL(result.url).pathname, title: record.title, year: record.year, kind: series ? 'series' : 'movie', id: record.id, locked: true };
      const fresh = recordFromWalk(entry, result.walked, { id: record.id });
      if (fresh) upsertRecord(vault, fresh);
      const pruned = pruneDeadEmbeds(record, dead);
      stats.refreshed += 1;
      stats.pruned += pruned.pruned;
      if (pruned.keptAll) stats.stuck.push({ id: record.id, url: record.pageUrl, kind: record.kind || 'movie', reason: 'every embed is dead and the re-walk found nothing' });
      continue;
    }
    // Keep the record as-is and let the retry ladder handle it. Say WHICH way it
    // failed: an unreachable page is a transient network problem, a page that
    // reads fine but offers nothing live is a re-upload this sweep cannot fix.
    const unreachable = result.tried.some((t) => t.error);
    stats.stuck.push({
      id: record.id,
      url: record.pageUrl,
      kind: record.kind || 'movie',
      reason: unreachable
        ? `all embeds dead, re-walk failed (${result.tried.map((t) => t.error || t.url).join(', ')})`
        : 'every embed is dead and the page now offers nothing live',
    });
  }

  for (const leftover of needRefresh.slice(work.length)) {
    stats.stuck.push({ id: leftover.record.id, url: leftover.record.pageUrl, kind: leftover.record.kind || 'movie', reason: `dead links, refresh deferred to the next run (${leftover.dead.length})` });
  }
  if (budgetHit || sweep.results.length < urls.length) stats.partial = true; // the slice was cut short
  return stats;
}
