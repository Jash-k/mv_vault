import { backfillPosters } from './posters.js';
import { needsMetadata, keyCount, enrichWithTmdb, fetchByTmdbId } from './tmdb.js';
import { checkEmbed } from './liveness.js';
import { enqueue, pathOf, HOURS } from './pipeline-core.js';
import { pruneDeadEmbeds } from './refresh.js';

export const freshMaintenance = () => ({ schemaVersion: 1, posters: {}, metadata: {}, links: {} });
export async function maintain({ vault, progress, aliases, config, maintenance, liveness, deadline, report, mode = 'releases' }) {
  const due = (table, filter, limit) => vault.filter(filter).filter(r => (table[r.id]?.nextAt || 0) <= Date.now())
    .sort((a, b) => (table[a.id]?.at || 0) - (table[b.id]?.at || 0)).slice(0, limit);
  const onlyPosters = mode === 'posters', onlyMetadata = mode === 'enrich', onlyLiveness = mode === 'liveness';
  if (!onlyMetadata && !onlyLiveness) {
    for (const record of due(maintenance.posters, r => !r.poster, config.posterLimit)) {
      if (Date.now() >= deadline) break;
      const result = await backfillPosters([record], { limit: 1, concurrency: 1 });
      maintenance.posters[record.id] = { at: Date.now(), nextAt: Date.now() + (result.unknown ? 6 : 168) * HOURS, outcome: result.filled ? 'filled' : result.unknown ? 'unknown' : 'absent' };
      if (result.filled) { record.updatedAt = new Date().toISOString(); report.postersFilled++; }
    }
  }
  if (keyCount() && !onlyPosters && !onlyLiveness) {
    for (const record of due(maintenance.metadata, needsMetadata, config.metadataLimit)) {
      if (Date.now() >= deadline) break;
      const kind = record.kind || 'movie';
      const trustedId = record.tmdbId && (kind !== 'series' || record.tmdbType === 'tv');
      const meta = trustedId ? await fetchByTmdbId(record.tmdbId, kind) : await enrichWithTmdb({ title: record.title, year: record.year, kind });
      maintenance.metadata[record.id] = { at: Date.now(), nextAt: Date.now() + (meta ? 168 : 24) * HOURS, outcome: meta ? 'matched' : 'unmatched-or-unavailable' };
      if (!meta) continue;
      // Do not rewrite identity/year. Legacy unknown-type series metadata only changes on a new exact TV match.
      record.tmdbId = meta.tmdbId; record.tmdbType = meta.tmdbType;
      record.poster = meta.poster || record.poster; record.imdbId = meta.imdbId || record.imdbId;
      record.rating = meta.rating; record.updatedAt = new Date().toISOString(); report.metadataFilled++;
    }
  }
  if (onlyPosters || onlyMetadata) return;
  const records = [...vault].sort((a, b) => (Date.parse(liveness[a.id]?.at || '') || 0) - (Date.parse(liveness[b.id]?.at || '') || 0)).slice(0, config.livenessRecords);
  const memo = new Map();
  for (const record of records) {
    if (Date.now() >= deadline) break;
    const results = [];
    for (const e of record.embeds) {
      if (Date.now() >= deadline) break;
      if (!memo.has(e.url)) {
        const verdict = await checkEmbed(e.url); memo.set(e.url, verdict); report.embedsChecked++;
        const old = maintenance.links[e.url] || {};
        const spaced = !old.at || Date.now() - old.at >= 6 * HOURS;
        const streak = verdict.state === 'dead' ? (old.streak || 0) + (spaced ? 1 : 0) : 0;
        maintenance.links[e.url] = { state: verdict.state, streak, at: spaced || verdict.state !== 'dead' ? Date.now() : old.at };
      }
      results.push(memo.get(e.url));
    }
    if (results.length !== record.embeds.length) continue;
    const dead = results.filter(r => r.state === 'dead');
    liveness[record.id] = { at: new Date().toISOString(), live: results.filter(r => r.state === 'live').length, dead: dead.length, unknown: results.filter(r => r.state === 'unknown').length };
    report.deadLinks += dead.length;
    if (!dead.length) continue;
    enqueue(progress, [{ url: record.pageUrl, kind: record.kind || 'movie' }], vault, aliases, 'repair');
    const job = progress.jobs[pathOf(record.pageUrl)];
    if (job) { job.status = 'failed'; job.nextAt = 0; job.lastError = 'Maintenance found dead links'; }
    if (config.autoPruneDeadLinks) {
      const confirmed = dead.filter(r => maintenance.links[r.url].streak >= 2).map(r => r.url);
      const result = pruneDeadEmbeds(record, confirmed);
      report.pruned += result.pruned;
    }
  }
}
