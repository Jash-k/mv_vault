#!/usr/bin/env node
// Compatibility entry point. All production modes use candidate staging.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const input = process.argv.slice(2), args = [];
let mode = 'archive';
for (const a of input) {
 if (a === '--incremental') mode = 'releases';
 else if (a === '--sweep' || a === '--letters=a-z') mode = 'archive';
 else if (a === '--refresh') mode = 'liveness';
 else if (a === '--posters') mode = 'posters';
 else if (a.startsWith('--queue=')) { mode = 'queue'; args.push(a); }
 else if (a.startsWith('--max-movies=')) args.push(a.replace('--max-movies=', '--max-items='));
 else if (a.startsWith('--budget-min=') || ['--dry', '--apply', '--prepare'].includes(a)) args.push(a);
 else throw new Error(`Unsupported legacy flag ${a}. Use config/workflows.json or README.md; no flag is silently ignored.`);
}
const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/run-job.mjs', import.meta.url)), `--mode=${mode}`, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
