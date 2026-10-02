#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/run-job.mjs', import.meta.url)), '--mode=enrich', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
