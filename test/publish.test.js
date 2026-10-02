import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, DATA_FILES, validateCandidate } from '../scripts/validate-candidate.mjs';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture() {
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vault-publish-')),remote=path.join(temp,'remote.git'),repo=path.join(temp,'repo');
 fs.mkdirSync(repo);git(temp,'init','--bare',remote);git(repo,'init','-b','main');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
 for(const dir of ['src','scripts','config','data'])fs.cpSync(path.join(ROOT,dir),path.join(repo,dir),{recursive:true});
 for(const file of ['package.json','.gitignore'])fs.copyFileSync(path.join(ROOT,file),path.join(repo,file));
 git(repo,'add','.');git(repo,'commit','-m','baseline');git(repo,'remote','add','origin',remote);git(repo,'push','-u','origin','main');
 const candidate=path.join(repo,'.runs/releases/candidate');fs.mkdirSync(candidate,{recursive:true});fs.cpSync(path.join(repo,'data'),path.join(candidate,'data'),{recursive:true});
 const report=JSON.parse(fs.readFileSync(path.join(candidate,'data/last-run.json')));report.testMarker='approved candidate';fs.writeFileSync(path.join(candidate,'data/last-run.json'),JSON.stringify(report));
 const hashes={};for(const name of DATA_FILES){const f=path.join(candidate,'data',name);if(fs.existsSync(f))hashes[name]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}
 const ready={mode:'releases',sourceSha:git(repo,'rev-parse','HEAD'),dry:false,degraded:false,hashes};const readyFile=path.join(repo,'.runs/releases/READY.json');fs.writeFileSync(readyFile,JSON.stringify(ready));
 const run=()=>spawnSync(process.execPath,[path.join(repo,'scripts/publish.mjs'),'releases'],{cwd:repo,encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'false',VAULT_BRANCH:'main'}});
 return {temp,remote,repo,candidate,ready,readyFile,run,cleanup:()=>fs.rmSync(temp,{recursive:true,force:true})};
}
test('publisher pushes only approved data and never source files',()=>{
 const f=fixture();try{
 const old=git(f.repo,'rev-parse','HEAD'),r=f.run();assert.equal(r.status,0,r.stdout+r.stderr);
 const head=git(f.temp,'--git-dir='+f.remote,'rev-parse','refs/heads/main');assert.notEqual(head,old);
 const changed=git(f.temp,'--git-dir='+f.remote,'diff','--name-only',old,head).split('\n');assert.deepEqual(changed,['data/last-run.json']);
 assert.equal(git(f.repo,'status','--porcelain','--untracked-files=no'),'');
 }finally{f.cleanup();}
});
test('concurrent manual code push makes publisher fail safely without reverting it',()=>{
 const f=fixture();try{
 const other=path.join(f.temp,'other');git(f.temp,'clone','--branch','main',f.remote,other);git(other,'config','user.name','Human');git(other,'config','user.email','human@example.invalid');
 fs.writeFileSync(path.join(other,'src/human-change.js'),'export const human = true;\n');git(other,'add','.');git(other,'commit','-m','human edit');git(other,'push');
 const human=git(other,'rev-parse','HEAD'),r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/Upstream\/HEAD changed/);
 assert.equal(git(f.temp,'--git-dir='+f.remote,'rev-parse','refs/heads/main'),human);
 assert.equal(git(f.temp,'--git-dir='+f.remote,'show','main:src/human-change.js'),'export const human = true;');
 }finally{f.cleanup();}
});
test('candidate modification after approval cannot be published',()=>{
 const f=fixture();try{fs.appendFileSync(path.join(f.candidate,'data/last-run.json'),' ');const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/changed after approval/);}finally{f.cleanup();}
});
test('dry candidate cannot be published',()=>{
 const f=fixture();try{f.ready.dry=true;fs.writeFileSync(f.readyFile,JSON.stringify(f.ready));const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/dry-run/);}finally{f.cleanup();}
});
test('candidate cannot remove existing records or publish orphan done jobs',()=>{
 const f=fixture();try{
 const name=path.join(f.candidate,'data/vault.json'),old=fs.readFileSync(name);const records=JSON.parse(old);records.pop();fs.writeFileSync(name,JSON.stringify(records));assert.throws(()=>validateCandidate(f.candidate,f.repo,{quiet:true}),/shrink/);
 fs.writeFileSync(name,old);fs.writeFileSync(path.join(f.candidate,'data/releases-state.json'),JSON.stringify({schemaVersion:1,jobs:{missing:{status:'done',id:'missing'}}}));assert.throws(()=>validateCandidate(f.candidate,f.repo,{quiet:true}),/without a vault record/);
 }finally{f.cleanup();}
});
test('missing guard data, stale index and corrupt data are rejected',()=>{
 const f=fixture();try{
 const file=path.join(f.candidate,'data/index.json');const rows=JSON.parse(fs.readFileSync(file));rows[0].t='stale';fs.writeFileSync(file,JSON.stringify(rows));assert.throws(()=>validateCandidate(f.candidate,f.repo,{quiet:true}),/index content/);
 fs.copyFileSync(path.join(f.repo,'data/index.json'),file);fs.unlinkSync(path.join(f.candidate,'data/known-drift.json'));assert.throws(()=>validateCandidate(f.candidate,f.repo,{quiet:true}));
 }finally{f.cleanup();}
});
