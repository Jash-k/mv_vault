import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const dir of ['src', 'scripts', 'test']) {
 for (const file of fs.readdirSync(dir).filter(f => /\.(js|mjs)$/.test(f))) {
  const r = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
 }
}
for (const file of ['scripts/test.mjs', 'src/verify.js']) {
 const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
 if (r.status !== 0) process.exit(r.status ?? 1);
}
