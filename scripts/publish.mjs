#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, DATA_FILES, validateCandidate } from './validate-candidate.mjs';
const mode = process.argv[2];
if (!['releases', 'archive', 'enrich', 'posters', 'liveness', 'queue'].includes(mode)) throw new Error('Expected mode argument');
const run = path.join(ROOT, '.runs', mode), candidate = path.join(run, 'candidate');
const ready = JSON.parse(fs.readFileSync(path.join(run, 'READY.json'), 'utf8'));
for (const file of DATA_FILES.slice(0, 7)) if (!ready.hashes?.[file]) throw new Error(`Approval missing required file: ${file}`);
if (ready.dry) throw new Error('Cannot publish a dry-run candidate');
const branch = process.env.VAULT_BRANCH || 'main';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
git('check-ref-format', '--branch', branch);
if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF_NAME !== branch) throw new Error('Writes are restricted to the default branch');
if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('Tracked working tree is dirty; publisher refuses to overwrite local edits');
for (const [file, hash] of Object.entries(ready.hashes)) {
  if (!DATA_FILES.includes(file)) throw new Error(`Unapproved data path: ${file}`);
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(candidate, 'data', file))).digest('hex') !== hash) throw new Error(`Candidate changed after approval: ${file}`);
}
validateCandidate(candidate, ROOT);
git('fetch', 'origin', branch);
const remote = git('rev-parse', `origin/${branch}`);
if (remote !== ready.sourceSha || git('rev-parse', 'HEAD') !== ready.sourceSha) throw new Error('Upstream/HEAD changed since the crawl. No overwrite attempted; rerun against latest main. Candidate remains in artifacts.');
const worktree = path.join(ROOT, '.runs', `publish-${process.pid}`);
git('worktree', 'add', '--detach', worktree, remote);
try {
  const inTree = (...args) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();
  for (const file of Object.keys(ready.hashes)) fs.copyFileSync(path.join(candidate, 'data', file), path.join(worktree, 'data', file));
  validateCandidate(worktree, ROOT, { quiet: true });
  inTree('add', '--', ...Object.keys(ready.hashes).map(f => `data/${f}`));
  const staged = inTree('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (!staged.every(f => DATA_FILES.map(n => `data/${n}`).includes(f))) throw new Error('Publisher staged a non-data path');
  if (!staged.length) console.log('No data changes.');
  else {
    inTree('-c', 'user.name=vault-bot', '-c', 'user.email=actions@users.noreply.github.com', 'commit', '-m', `vault: ${mode} ${new Date().toISOString()}`);
    // Normal fast-forward push only. A race fails safely; never force-push or reset a stale index.
    inTree('push', 'origin', `HEAD:refs/heads/${branch}`);
    console.log(`Published ${staged.length} validated data files.`);
  }
} finally { git('worktree', 'remove', '--force', worktree); }
