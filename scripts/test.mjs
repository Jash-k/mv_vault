import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const files = fs.readdirSync('test').filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
if (!files.length) throw new Error('No regression tests found; refusing a false-green test run');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, VAULT_MIN_INTERVAL_MS: '0' } });
process.exit(result.status ?? 1);
