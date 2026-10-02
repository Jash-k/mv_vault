#!/usr/bin/env node
// No automatic ID renames: permanent consumer IDs are preserved.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (!args.includes('--apply') && !args.includes('--dry')) args.push('--dry');
const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/run-job.mjs', import.meta.url)), '--mode=liveness', ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
