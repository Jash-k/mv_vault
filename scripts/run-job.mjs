#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, DATA_FILES, validateCandidate } from './validate-candidate.mjs';
const args = process.argv.slice(2);
const arg = (key, fallback) => args.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const mode = arg('mode', 'releases');
if (!['releases', 'archive', 'enrich', 'posters', 'liveness', 'queue'].includes(mode)) throw new Error('Unknown run mode');
for (const a of args) if (!/^--(?:mode|max-items|budget-min|queue)=/.test(a) && !['--apply', '--dry', '--prepare'].includes(a)) throw new Error(`Unknown argument ${a}`);
if (args.includes('--dry') && args.includes('--apply')) throw new Error('--dry and --apply are mutually exclusive');
const runs = path.join(ROOT, '.runs'), run = path.join(runs, mode), candidate = path.join(run, 'candidate');
fs.mkdirSync(runs, { recursive: true });
const lockFile = path.join(runs, 'LOCK');
let lock;
try { lock = fs.openSync(lockFile, 'wx'); } catch { throw new Error('Another local job or stale .runs/LOCK exists. Check the process before removing the lock.'); }
fs.writeFileSync(lock, `${process.pid}\n`);
try {
  if (fs.existsSync(path.join(ROOT, '.data-backup'))) throw new Error('Interrupted local apply detected. Restore .data-backup to data before proceeding.');
  fs.rmSync(run, { recursive: true, force: true }); fs.mkdirSync(candidate, { recursive: true });
  fs.cpSync(path.join(ROOT, 'data'), path.join(candidate, 'data'), { recursive: true });
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || 'local-no-git';
  const env = { ...process.env, VAULT_CANDIDATE: '1', VAULT_MODE: mode, VAULT_SOURCE_SHA: sha };
  if (arg('max-items')) env.VAULT_MAX_ITEMS = arg('max-items');
  if (arg('budget-min')) env.VAULT_BUDGET_MIN = arg('budget-min');
  if (mode === 'queue') {
    if (!arg('queue')) throw new Error('Queue mode requires --queue=path.json');
    env.VAULT_QUEUE_FILE = path.resolve(arg('queue'));
  }
  const logfile = fs.openSync(path.join(run, 'run.log'), 'w');
  console.log(`Running ${mode}; live log: ${path.join(run, 'run.log')}`);
  let result;
  try {
    result = spawnSync(process.execPath, [path.join(ROOT, 'src/pipeline.js')], { cwd: candidate, env, stdio: ['ignore', logfile, logfile], timeout: 65 * 60000 });
  } finally { fs.closeSync(logfile); }
  if (![0, 2].includes(result.status) || !fs.existsSync(path.join(candidate, 'result.json'))) throw new Error(`Pipeline failed (${result.status ?? result.error?.message}); candidate NOT approved. See ${path.join(run, 'run.log')}`);
  validateCandidate(candidate, ROOT);
  const report = JSON.parse(fs.readFileSync(path.join(candidate, 'result.json')));
  const hashes = {};
  for (const file of DATA_FILES) {
    const full = path.join(candidate, 'data', file);
    if (fs.existsSync(full)) hashes[file] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  fs.writeFileSync(path.join(run, 'READY.json'), JSON.stringify({ mode, sourceSha: sha, dry: args.includes('--dry'), degraded: report.degraded, hashes }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (args.includes('--apply')) {
    // Whole directory swap, not ten unrelated copies. Backup is retained on an interrupted swap.
    const backup = path.join(ROOT, '.data-backup'), ready = path.join(ROOT, '.data-ready');
    fs.rmSync(ready, { recursive: true, force: true }); fs.cpSync(path.join(candidate, 'data'), ready, { recursive: true });
    fs.renameSync(path.join(ROOT, 'data'), backup);
    try { fs.renameSync(ready, path.join(ROOT, 'data')); } catch (error) { fs.renameSync(backup, path.join(ROOT, 'data')); throw error; }
    fs.rmSync(backup, { recursive: true });
    console.log('Validated data generation applied locally. No Git push performed.');
  } else console.log('Prepared candidate only; working data unchanged. Use --apply for a local update.');
  // Workflow publishes coherent safe progress even when a source is degraded, then explicitly fails the run.
  if (!args.includes('--prepare')) process.exitCode = report.degraded ? 2 : 0;
} finally {
  fs.closeSync(lock); fs.rmSync(lockFile, { force: true });
}
