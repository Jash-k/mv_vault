import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import { isItemPath, kindOfPath } from './sections.js';
import { titleForEntry, isRejected } from './titles.js';
import { slugify } from './http.js';
import { recordFromWalk, upsertRecord, markDone, markPartial, markEmpty, markFailed } from './store.js';

export const HOURS = 3600000;
export const pathOf = url => new URL(url, 'https://moviesda34.com').pathname.replace(/\/+$/, '') + '/';
export const freshProgress = mode => ({
  schemaVersion: 1, mode, jobs: {}, collisions: {},
  archive: { cycle: 1, letter: 'a', page: 1, fingerprints: [], completedAt: null, nextCycleAt: null },
  releasePages: {},
});
export function validateProgress(p, mode) {
  if (p?.schemaVersion !== 1 || p.mode !== mode || !p.jobs || Array.isArray(p.jobs) || typeof p.jobs !== 'object') throw new Error(`Invalid ${mode} progress; refusing to reset it`);
  if (!/^[a-z]$/.test(p.archive?.letter) || !Number.isInteger(p.archive.page) || p.archive.page < 1 || !Array.isArray(p.archive.fingerprints)) throw new Error('Invalid archive cursor');
  for (const [key, j] of Object.entries(p.jobs)) {
    if (key !== pathOf(j.url) || !j.id || !['movie', 'series'].includes(j.kind) || !Number.isFinite(j.nextAt) || j.nextAt < 0) throw new Error(`Invalid persisted job: ${key}`);
  }
  return p;
}

/** Parse only actual item links; malformed/challenge/ambiguous empty pages fail closed. */
export function parseListing(html, url, page = 1) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  if (/just a moment|verify you are human|access denied|checking your browser/i.test($('title').text() + ' ' + text.slice(0, 400))) throw new Error('Listing returned a challenge/error document');
  const rows = new Map();
  $('a[href]').each((_, a) => {
    let href;
    try { href = new URL($(a).attr('href'), url); } catch { return; }
    if (!['http:', 'https:'].includes(href.protocol)) return;
    if (!['moviesda34.com', 'moviezda.net', new URL(url).hostname].includes(href.hostname)) return;
    const path = pathOf(href.href);
    if (!isItemPath(path)) return;
    rows.set(path, { path, url: new URL(path, url).href, label: $(a).text().replace(/\s+/g, ' ').trim(), kind: kindOfPath(path) });
  });
  const items = [...rows.values()];
  const explicitEnd = /no (?:movies|items|results|files)(?: found| available)?/i.test(text);
  if (!items.length && !(page > 1 && explicitEnd)) throw new Error(`Listing has no recognized items at ${url}; cursor NOT advanced`);
  const fingerprint = crypto.createHash('sha256').update(items.map(r => r.path).sort().join('\n')).digest('hex');
  return { items, fingerprint, ended: !items.length && explicitEnd };
}

/** One path per job. Aliases remain separate paths, all locked to the existing ID. */
export function enqueue(progress, rows, vault, aliases = {}, source = 'discovery') {
  const byPath = new Map(vault.map(r => [pathOf(r.pageUrl), r]));
  const byId = new Map(vault.map(r => [r.id, r]));
  let added = 0;
  for (const row of rows) {
    const path = pathOf(row.path || row.url);
    if ((aliases.skipPaths || []).map(pathOf).includes(path)) continue;
    if (progress.jobs[path]) continue;
    const targetId = aliases.mergeInto?.[path];
    const stored = targetId ? byId.get(targetId) : byPath.get(path);
    if (targetId && !stored) throw new Error(`Alias target missing: ${targetId}`);
    const identity = stored || titleForEntry({ ...row, path });
    if (isRejected(row.label, path, identity)) continue;
    const id = stored?.id || `${slugify(identity.title)}${identity.year ? `-${identity.year}` : ''}`;
    // Same computed identity on a different page is not proof of sameness.
    if (!stored && byId.has(id)) {
      (progress.collisions ||= {})[path] = { id, url: row.url, reason: 'Computed ID already belongs to a different stored page; explicit alias required' };
      continue;
    }
    const queuedCollision = Object.values(progress.jobs).find(j => j.id === id && j.path !== path && !stored);
    if (queuedCollision) {
      (progress.collisions ||= {})[path] = { id, url: row.url, reason: `Computed ID also belongs to queued ${queuedCollision.path}; explicit identity review required` };
      continue;
    }
    if (progress.collisions) delete progress.collisions[path];
    progress.jobs[path] = {
      path, url: row.url, id, title: identity.title, year: identity.year || 0,
      kind: stored?.kind === 'series' ? 'series' : stored ? 'movie' : row.kind || kindOfPath(path),
      locked: Boolean(stored), source, ...(targetId ? { refreshHours: aliases.refreshHours || 24 } : {}), status: 'pending', nextAt: 0,
      attempts: 0, failures: 0, emptyAttempts: 0, discoveredAt: new Date().toISOString(),
    };
    added++;
  }
  return added;
}

export function seedReleaseRefresh(progress, vault, aliases, config, now = Date.now()) {
  const date = new Date(now), year = config.releaseYear === 'current' ? date.getUTCFullYear() : Number(config.releaseYear);
  const years = [year];
  if (date.getUTCMonth() < config.previousYearGraceMonths) years.push(year - 1);
  // Existing series stay tracked after they leave the latest listing.
  const rows = vault.filter(r => r.kind === 'series' || years.includes(r.year)).map(r => ({ url: r.pageUrl, kind: r.kind || 'movie' }));
  enqueue(progress, rows, vault, aliases, 'refresh');
  enqueue(progress, Object.keys(aliases.mergeInto || {}).map(path => ({ path, url: new URL(path, aliases.origin || config.origin).href })), vault, aliases, 'alias');
  return years;
}

/** Weighted round-robin prevents any one queue class starving the others. */
export function selectDue(progress, limit, now = Date.now()) {
  const due = Object.values(progress.jobs).filter(j => j.nextAt <= now && j.status !== 'quarantined');
  const groups = { fresh: [], series: [], retry: [], refresh: [] };
  for (const j of due) {
    const type = j.kind === 'series' ? 'series' : j.attempts === 0 && !j.locked ? 'fresh' : ['failed', 'empty', 'partial'].includes(j.status) ? 'retry' : 'refresh';
    groups[type].push(j);
  }
  for (const rows of Object.values(groups)) rows.sort((a, b) => a.nextAt - b.nextAt || a.path.localeCompare(b.path));
  const out = [], rotation = ['fresh', 'series', 'fresh', 'retry', 'refresh'];
  while (out.length < limit && Object.values(groups).some(g => g.length)) {
    for (const key of rotation) if (groups[key].length && out.length < limit) out.push(groups[key].shift());
  }
  return out;
}

export function nextAfter(job, outcome, config, mode, now = Date.now()) {
  if (outcome === 'failed' || outcome === 'unknown') return now + Math.min(24, 1.5 * 2 ** Math.min(job.failures, 4)) * HOURS;
  if (outcome === 'partial') return now + 6 * HOURS;
  if (outcome === 'empty') return now + [12, 24, 72, 168, 720][Math.min(job.emptyAttempts - 1, 4)] * HOURS;
  if (mode === 'archive') return now + config.archiveRefreshDays * 24 * HOURS;
  return now + (job.refreshHours || (job.kind === 'series' ? config.seriesRefreshHours : config.recentMovieRefreshHours)) * HOURS;
}

/** One successful listing page is durably enqueued before its next cursor is saved. */
export async function discoverArchive({ progress, vault, aliases, config, fetchListing, save, deadline, now = Date.now }) {
  const a = progress.archive;
  if (a.completedAt) {
    if (now() < Date.parse(a.nextCycleAt)) return;
    Object.assign(a, { cycle: a.cycle + 1, letter: 'a', page: 1, fingerprints: [], completedAt: null, nextCycleAt: null });
  }
  let pages = 0;
  while (pages < config.archiveListingPages && now() < deadline) {
    const backlog = Object.values(progress.jobs).filter(j => j.attempts === 0).length;
    if (backlog >= config.archiveMaxItems) break;
    const url = new URL(`/tamil-movies/${a.letter}/${a.page > 1 ? `?page=${a.page}` : ''}`, config.origin).href;
    const page = parseListing(await fetchListing(url), url, a.page);
    const repeated = a.fingerprints.includes(page.fingerprint);
    if (page.ended || repeated) {
      if (a.letter === 'z') {
        a.completedAt = new Date(now()).toISOString();
        a.nextCycleAt = new Date(now() + config.archiveCyclePauseDays * 24 * HOURS).toISOString();
        await save(); break;
      }
      a.letter = String.fromCharCode(a.letter.charCodeAt(0) + 1); a.page = 1; a.fingerprints = [];
    } else {
      enqueue(progress, page.items, vault, aliases, 'archive');
      a.fingerprints.push(page.fingerprint); a.page++;
    }
    pages++;
    await save();
  }
}

export async function discoverReleases({ progress, vault, aliases, config, fetchListing, save, deadline, now = Date.now }) {
  const years = seedReleaseRefresh(progress, vault, aliases, config, now());
  const problems = [];
  // Always refresh the first year page, plus a persisted deeper-page cursor.
  for (const year of years) {
    const cursor = progress.releasePages[year] || { page: 1, fingerprints: [] };
    progress.releasePages[year] = cursor;
    for (let n = 0; n < config.releaseListingPages && now() < deadline; n++) {
      const pageNo = n === 0 ? 1 : Math.max(2, cursor.page);
      const url = new URL(`/tamil-${year}-movies/${pageNo > 1 ? `?page=${pageNo}` : ''}`, config.origin).href;
      try {
        const page = parseListing(await fetchListing(url), url, pageNo);
        if (pageNo > 1 && (page.ended || cursor.fingerprints.includes(page.fingerprint))) {
          cursor.page = 1; cursor.fingerprints = []; break;
        }
        enqueue(progress, page.items, vault, aliases, 'release');
        if (pageNo === 1 && cursor.page <= 1) { cursor.page = 2; cursor.fingerprints = [page.fingerprint]; }
        else if (pageNo > 1) { cursor.page = pageNo + 1; cursor.fingerprints.push(page.fingerprint); }
        await save();
      } catch (error) { problems.push(`year ${year}: ${error.message}`); break; }
    }
  }
  const seen = new Set();
  for (let n = 1; n <= config.seriesListingPages && now() < deadline; n++) {
    const url = new URL(`/tamil-web-series-download/${n > 1 ? `?get-page=${n}` : ''}`, config.origin).href;
    try {
      const page = parseListing(await fetchListing(url), url, n);
      if (page.ended || seen.has(page.fingerprint)) break;
      seen.add(page.fingerprint);
      enqueue(progress, page.items, vault, aliases, 'latest-series');
      await save();
    } catch (error) { problems.push(`series: ${error.message}`); break; }
  }
  return problems;
}

/** Walk first, then apply results. Empty decisions use canaries, not empty-backlog ratios. */
export async function processJobs({ progress, vault, state, config, mode, walkPage, save, deadline, healthy = true, now = Date.now }) {
  const limit = mode === 'releases' ? config.releaseMaxItems : config.archiveMaxItems;
  const jobs = selectDue(progress, limit, now());
  const counts = { added: 0, merged: 0, unchanged: 0, empty: 0, failed: 0, partial: 0, deferred: 0, netEmbeds: 0 };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(config.concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length && now() < deadline) {
      const job = jobs[cursor++];
      let walked, error;
      try { walked = await walkPage(job.url); } catch (e) { error = e; }
      if (now() >= deadline) { counts.deferred++; continue; } // no false failure for canceled work
      // A record may have been added by the other workflow since this job was queued.
      const existing = vault.find(r => pathOf(r.pageUrl) === job.path || r.id === job.id);
      if (existing) Object.assign(job, { id: existing.id, title: existing.title, year: existing.year, kind: existing.kind || 'movie', locked: true });
      const record = walked ? recordFromWalk(job, walked, { id: job.id }) : null;
      const outcome = error ? 'failed' : record ? (walked.partial ? 'partial' : 'done') : walked.partial || !healthy ? 'unknown' : 'empty';
      job.attempts++; job.lastAttemptAt = new Date(now()).toISOString();
      job.status = outcome; job.lastError = error?.message || (outcome === 'unknown' ? 'Source health uncertain; no empty verdict accepted' : '');
      if (record) {
        const before = vault.reduce((n, r) => n + r.embeds.length, 0);
        const result = upsertRecord(vault, record);
        job.id = result.record.id; job.locked = true;
        counts[result.action]++; counts.netEmbeds += vault.reduce((n, r) => n + r.embeds.length, 0) - before;
        job.failures = 0; job.emptyAttempts = 0;
        if (walked.partial) { counts.partial++; markPartial(state, job.url, { kind: job.kind, embeds: result.record.embeds.length }); }
        else markDone(state, job.url, { kind: job.kind, embeds: result.record.embeds.length });
      } else if (outcome === 'empty') {
        counts.empty++; job.emptyAttempts++; job.failures = 0; markEmpty(state, job.url, { kind: job.kind });
      } else {
        counts.failed++;
        // Global unknown health does not escalate per-item counters or terminal states.
        if (healthy && outcome === 'failed') job.failures++;
        markFailed(state, job.url, { kind: job.kind, error: job.lastError });
        if (!healthy) { state.done[job.url].failures = 0; delete state.done[job.url].dead; }
      }
      job.nextAt = nextAfter(job, outcome, config, mode, now());
      // synchronous save implementation serializes a complete checkpoint; no awaiting before mutation ends
      await save();
    }
  }));
  counts.deferred += jobs.length - cursor;
  return counts;
}
