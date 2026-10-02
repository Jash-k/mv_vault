import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../scripts/validate-candidate.mjs';
const hashes=dir=>Object.fromEntries(fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,f))).digest('hex')]));
test('full staged archive dry-run and apply work with offline fetch, without mixed generations',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vault-e2e-'));
 try{
 for(const dir of ['src','scripts','config','data'])fs.cpSync(path.join(ROOT,dir),path.join(temp,dir),{recursive:true});
 fs.copyFileSync(path.join(ROOT,'package.json'),path.join(temp,'package.json'));
 fs.symlinkSync(path.join(ROOT,'node_modules'),path.join(temp,'node_modules'),'dir');
 const configPath=path.join(temp,'config/workflows.json'),config=JSON.parse(fs.readFileSync(configPath));
 const vault=JSON.parse(fs.readFileSync(path.join(temp,'data/vault.json')));
 Object.assign(config,{canaryRecordIds:[vault[0].id],archiveListingPages:1,archiveMaxItems:2,posterLimit:0,metadataLimit:0,livenessRecords:0});fs.writeFileSync(configPath,JSON.stringify(config));
 const env={...process.env,NODE_OPTIONS:`--import=${path.join(ROOT,'test/fixtures/preload.mjs')}`,FIXTURE_VAULT:path.join(temp,'data/vault.json'),VAULT_MIN_INTERVAL_MS:'0'};
 const before=hashes(path.join(temp,'data'));
 const run=(...args)=>spawnSync(process.execPath,[path.join(temp,'scripts/run-job.mjs'),'--mode=archive',...args],{cwd:temp,env,encoding:'utf8',timeout:30000});
 const dry=run('--dry');assert.equal(dry.status,0,dry.stdout+dry.stderr);assert.deepEqual(hashes(path.join(temp,'data')),before);
 const ready=JSON.parse(fs.readFileSync(path.join(temp,'.runs/archive/READY.json')));assert(ready.dry);
 const progress=JSON.parse(fs.readFileSync(path.join(temp,'.runs/archive/candidate/data/archive-state.json')));assert.equal(progress.archive.page,2);assert.equal(Object.values(progress.jobs)[0].status,'done');
 const apply=run('--apply');assert.equal(apply.status,0,apply.stdout+apply.stderr);
 assert(fs.existsSync(path.join(temp,'data/archive-state.json')));assert(!fs.existsSync(path.join(temp,'.data-backup')));
 const verify=spawnSync(process.execPath,[path.join(temp,'src/verify.js')],{cwd:temp,encoding:'utf8'});assert.equal(verify.status,0,verify.stdout+verify.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
