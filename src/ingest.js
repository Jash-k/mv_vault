#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (!args.some(a => a.startsWith('--queue='))) throw new Error('Use npm run ingest -- --queue=path.json [--apply]');
const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/run-job.mjs', import.meta.url)), '--mode=queue', ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
