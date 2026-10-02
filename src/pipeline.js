#!/usr/bin/env node
// Runs only inside the candidate workspace created by scripts/run-job.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { loadData, saveAll, writeJson, saveRun, loadLiveness, saveLiveness } from './store.js';
import { createWalk, walkItem } from './walk.js';
import { httpStats } from './http.js';
import { loadPageAliases, loadAliases } from './delta.js';
import { freshProgress, validateProgress, seedReleaseRefresh, discoverArchive, discoverReleases, processJobs, enqueue } from './pipeline-core.js';
import { maintain, freshMaintenance } from './maintenance.js';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'config/workflows.json'), 'utf8'));
const mode = process.env.VAULT_MODE;
if (!process.env.VAULT_CANDIDATE || !['releases', 'archive', 'posters', 'enrich', 'liveness', 'queue'].includes(mode)) throw new Error('Use npm run releases / archive (staged runner required)');
const numeric = {
  previousYearGraceMonths: [0, 12], releaseListingPages: [1, 100], seriesListingPages: [1, 100],
  releaseMaxItems: [1, 2000], archiveMaxItems: [1, 2000], archiveListingPages: [1, 100],
  releaseBudgetMinutes: [1, 45], archiveBudgetMinutes: [1, 60], concurrency: [1, 8],
  seriesRefreshHours: [1, 720], recentMovieRefreshHours: [1, 2160], archiveRefreshDays: [1, 365],
  archiveCyclePauseDays: [1, 365], posterLimit: [0, 200], metadataLimit: [0, 200], livenessRecords: [0, 200], maxRequests: [1, 50000],
};
if (process.env.VAULT_MAX_ITEMS) config[mode === 'archive' || mode === 'queue' ? 'archiveMaxItems' : 'releaseMaxItems'] = Number(process.env.VAULT_MAX_ITEMS);
if (process.env.VAULT_BUDGET_MIN) config[mode === 'archive' || mode === 'queue' ? 'archiveBudgetMinutes' : 'releaseBudgetMinutes'] = Number(process.env.VAULT_BUDGET_MIN);
for (const [key, [min, max]] of Object.entries(numeric)) if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid config ${key}; expected integer ${min}..${max}`);
if (config.releaseYear !== 'current' && (!Number.isInteger(config.releaseYear) || config.releaseYear < 2000 || config.releaseYear > 2100)) throw new Error('Invalid releaseYear');
if (!['https://moviesda34.com', 'https://moviezda.net'].includes(config.origin)) throw new Error('Unapproved listing origin');
if (!Array.isArray(config.canaryRecordIds) || typeof config.autoPruneDeadLinks !== 'boolean') throw new Error('Invalid health/maintenance configuration');
const started = Date.now(), minutes = mode === 'archive' || mode === 'queue' ? config.archiveBudgetMinutes : config.releaseBudgetMinutes;
const deadline = started + minutes * 60000;
process.env.VAULT_DEADLINE_MS = String(deadline);
process.env.VAULT_MAX_REQUESTS = String(config.maxRequests);
const { state, vault } = loadData();
const aliases = loadPageAliases();
aliases.skipPaths = [...new Set([...aliases.skipPaths, ...loadAliases(path.join('data', 'aliases.json'))])];
const progressMode = mode === 'archive' || mode === 'queue' ? 'archive' : 'releases';
const progressFile = `data/${progressMode}-state.json`;
function readOptional(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const progress = validateProgress(readOptional(progressFile, freshProgress(progressMode)), progressMode);
const maintenance = readOptional('data/maintenance-state.json', freshMaintenance());
if (maintenance.schemaVersion !== 1 || !maintenance.posters || !maintenance.metadata || !maintenance.links) throw new Error('Invalid maintenance state');
const liveness = loadLiveness();
const report = { schemaVersion: 2, mode, runId: process.env.GITHUB_RUN_ID || `local-${started}`, sourceSha: process.env.VAULT_SOURCE_SHA || '', startedAt: new Date(started).toISOString(), degraded: false, integrity: true, problems: [], counts: {}, canaries: [], postersFilled: 0, metadataFilled: 0, embedsChecked: 0, deadLinks: 0, pruned: 0 };
let lastSave = 0;
function save(force = false) {
  if (!force && Date.now() - lastSave < 2000) return;
  // Only candidate files change. Publishing validates and copies the entire generation together.
  saveAll({ state, vault }); writeJson(progressFile, progress);
  writeJson('data/maintenance-state.json', maintenance); saveLiveness(liveness); lastSave = Date.now();
}
const walk = createWalk({ concurrency: config.concurrency });
const walkPage = url => walkItem(url, { walk });

// A canary is a known-stored page that should still expose at least one source.
// Select two per kind when possible. At least one success per represented kind is required.
const selected = config.canaryRecordIds.length ? config.canaryRecordIds.map(id => {
  const r = vault.find(r => r.id === id); if (!r) throw new Error(`Canary ID missing: ${id}`); return r;
}) : ['movie', 'series'].flatMap(kind => vault.filter(r => (r.kind || 'movie') === kind)
  .sort((a, b) => String(b.updatedAt || b.addedAt || '').localeCompare(String(a.updatedAt || a.addedAt || ''))).slice(0, 2));
let healthy = true;
if (['releases', 'archive', 'queue'].includes(mode)) {
  for (const record of selected) {
    if (Date.now() >= deadline) { healthy = false; break; }
    try {
      const result = await walkPage(record.pageUrl);
      const count = result.embeds?.length || (result.seasons || []).reduce((n, s) => n + s.episodes.reduce((a, ep) => a + ep.embeds.length, 0), 0);
      report.canaries.push({ id: record.id, kind: record.kind || 'movie', ok: count > 0 && !result.partial });
    } catch (error) { report.canaries.push({ id: record.id, kind: record.kind || 'movie', ok: false, error: error.message }); }
  }
  for (const kind of new Set(selected.map(r => r.kind || 'movie'))) if (!report.canaries.some(c => c.kind === kind && c.ok)) healthy = false;
  if (!healthy) report.problems.push('Known-record canaries failed; empty verdicts remain unknown and cannot retire pages');
}

try {
  if (mode === 'archive') {
    await discoverArchive({ progress, vault, aliases, config, fetchListing: walk.get, save: () => save(true), deadline });
  } else if (mode === 'releases') {
    report.problems.push(...await discoverReleases({ progress, vault, aliases, config, fetchListing: walk.get, save: () => save(true), deadline }));
  } else if (mode === 'queue') {
    const rows = JSON.parse(fs.readFileSync(process.env.VAULT_QUEUE_FILE, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('Queue must be an array');
    enqueue(progress, rows, vault, aliases, 'manual'); save(true);
  }
} catch (error) {
  // A failed listing never advances that page. Already saved earlier pages remain valid.
  report.problems.push(`discovery: ${error.message}`);
}
if (['releases', 'archive', 'queue'].includes(mode)) {
  report.counts = await processJobs({ progress, vault, state, config, mode: progressMode, walkPage, save, deadline, healthy });
  if (report.counts.failed) report.problems.push(`${report.counts.failed} item(s) failed/unknown; retained in retry queue`);
}
// Release job maintains links/posters/metadata. Archive dedicates its budget to A–Z.
if (mode !== 'archive' && mode !== 'queue' && Date.now() < deadline) {
  if (mode === 'enrich' && !String(process.env.TMDB_KEYS || process.env.TMDB_API_KEY || '').trim()) report.problems.push('TMDB key absent; metadata mode did no work');
  await maintain({ vault, progress, aliases, config, maintenance, liveness, deadline, report, mode });
}
if (Object.keys(progress.collisions || {}).length) report.problems.push(`${Object.keys(progress.collisions).length} identity collision(s) quarantined for manual alias/identity review; see queue state`);
report.degraded = report.problems.length > 0;
report.finishedAt = new Date().toISOString(); report.durationSeconds = Math.round((Date.now() - started) / 1000);
report.budgetReached = Date.now() >= deadline; report.http = { ...httpStats };
report.backlog = Object.values(progress.jobs).filter(j => j.nextAt <= Date.now()).length;
report.archive = progressMode === 'archive' ? progress.archive : undefined;
save(true); saveRun(report);
fs.writeFileSync('result.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.degraded ? 2 : 0;
