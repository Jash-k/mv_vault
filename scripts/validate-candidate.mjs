import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DATA_FILES = ['vault.json', 'state.json', 'vault-stats.json', 'index.json', 'manifest.json', 'last-run.json', 'liveness.json', 'releases-state.json', 'archive-state.json', 'maintenance-state.json'];
export function validateCandidate(candidate, baseline, { quiet = false } = {}) {
  const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, 'data', name), 'utf8'));
  const old = read(baseline, 'vault.json'), fresh = read(candidate, 'vault.json');
  assert(Array.isArray(fresh) && fresh.length >= old.length, 'Candidate cannot shrink record count');
  const ids = new Set(fresh.map(r => r.id));
  for (const record of old) assert(ids.has(record.id), `Permanent ID disappeared: ${record.id}`);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/workflows.json')));
  const freshMap = new Map(fresh.map(r => [r.id, r]));
  let removed = 0;
  for (const record of old) {
    const urls = new Set(freshMap.get(record.id).embeds.map(e => e.url));
    removed += record.embeds.filter(e => !urls.has(e.url)).length;
  }
  assert(config.autoPruneDeadLinks || removed === 0, 'Unexpected embed removal with auto-prune disabled');
  assert(removed <= old.reduce((n, r) => n + r.embeds.length, 0) * 0.05, 'More than 5% of links removed; manual review required');
  for (const name of ['known-drift.json', 'aliases.json']) assert.equal(fs.readFileSync(path.join(candidate, 'data', name), 'utf8'), fs.readFileSync(path.join(baseline, 'data', name), 'utf8'), `${name} must not change automatically`);
  for (const name of ['releases-state.json', 'archive-state.json']) {
    if (!fs.existsSync(path.join(candidate, 'data', name))) continue;
    const progress = read(candidate, name);
    assert.equal(progress.schemaVersion, 1);
    for (const job of Object.values(progress.jobs)) {
      if (['done', 'partial'].includes(job.status)) assert(ids.has(job.id), `Published-success job without a vault record: ${job.id}`);
    }
  }
  const result = spawnSync(process.execPath, [path.join(ROOT, 'src/verify.js')], { cwd: candidate, encoding: 'utf8' });
  if (!quiet) process.stdout.write(result.stdout || '');
  if (result.status !== 0) throw new Error(`Candidate verification failed:\n${result.stdout}\n${result.stderr}`);
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) validateCandidate(path.resolve(process.argv[2]), path.resolve(process.argv[3] || ROOT));
