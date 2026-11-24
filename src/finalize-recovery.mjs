#!/usr/bin/env node
/** Join independently checkpointed metadata into the live crawl without replacing playback. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as V from './vault.mjs';
import { mergeMetadataStates, rememberMetadata } from './metadata-state.mjs';
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length+3);
if (fs.existsSync('data/.historic.lock')) throw Error('Stop/checkpoint the historical writer before finalizing.');
const vault=V.loadVault(), state=V.loadState();
const metadataDir=arg('metadata-dir');
const fields=['tmdbId','tmdbType','tmdbTitle','originalTitle','originalYear','originalLanguage','category','categorySource','poster','rating','imdbId','metadataVerification'];
let joined=0;
if(metadataDir){
 const metadata=JSON.parse(fs.readFileSync(path.join(metadataDir,'data/vault.json')));
 const metadataState=JSON.parse(fs.readFileSync(path.join(metadataDir,'data/state.json')));
 const map=new Map(metadata.map(r=>[r.id,r]));
 for(const record of vault){
  const from=map.get(record.id), attempt=metadataState.metadata?.[record.id];
  if(!from || !attempt || !from.metadataVerification)continue;
  if(String(attempt.checkedAt||'') < String(state.metadata?.[record.id]?.checkedAt||''))continue;
  if(attempt.status==='matched'){
   for(const key of fields)if(from[key]!==undefined)record[key]=from[key];
   if(from.sourceMetadata?.available && String(from.sourceMetadata.fetchedAt||'')>String(record.sourceMetadata?.fetchedAt||''))record.sourceMetadata=from.sourceMetadata;
   joined++;
  }else record.metadataVerification=from.metadataVerification;
 }
 state.metadata=mergeMetadataStates(state.metadata,metadataState.metadata);
 state.tmdbMiss={...state.tmdbMiss,...metadataState.tmdbMiss};
 for(const [id,entry]of Object.entries(state.metadata||{}))if(entry.status==='matched'||entry.status==='unavailable')delete state.tmdbMiss[id];
}
let publishedRecovered=0;
const candidateReport=arg('candidate-report');
if(candidateReport){
 const candidates=JSON.parse(fs.readFileSync(candidateReport)).results;
 const byId=new Map(vault.map(r=>[r.id,r]));
 for(const outcome of candidates){
  const record=byId.get(outcome.id);
  if(outcome.status!=='matched'||!record||record.tmdbId||state.metadata?.[record.id]?.status==='review')continue;
  V.applyMetadata(record,outcome.meta,{preferPoster:true});
  const checked=rememberMetadata(state,record,{status:'matched',reason:outcome.meta.match,meta:outcome.meta});
  record.metadataVerification={status:'verified',reason:outcome.meta.match,checkedAt:checked.checkedAt,
   evidenceUrls:[`https://www.themoviedb.org/${outcome.meta.tmdbType}/${outcome.meta.tmdbId}`,
    'https://github.com/Jash-k/mv_vault/blob/4929f779849ae9d3b6c35b4d297dbd3e23093b47/data/vault.json']};
  publishedRecovered++;
 }
}
const baselinePath=arg('baseline');
const baseline=baselinePath?JSON.parse(fs.readFileSync(baselinePath)):[];
const map=new Map(vault.map(r=>[r.id,r]));
const issues=[];
if(map.size!==vault.length)issues.push('duplicate-record-ids');
const key=e=>`${e.season||0}|${e.episode||0}|${e.quality||''}|${e.url}`;
let originalEmbeds=0;
for(const old of baseline){
 const current=map.get(old.id);
 if(!current){issues.push('missing-record:'+old.id);continue;}
 const embeds=new Set(current.embeds.map(key));
 for(const e of old.embeds||[]){originalEmbeds++;if(!embeds.has(key(e)))issues.push('missing-embed:'+old.id);}
}
for(const record of vault){
 if(record.kind!=='series')continue;
 const nested=(record.seasons||[]).flatMap(s=>(s.episodes||[]).flatMap(e=>(e.embeds||[]).map(v=>({...v,season:s.season,episode:e.episode}))));
 const flat=new Set(record.embeds.map(key));
 if(nested.length!==record.embeds.length||nested.some(e=>!flat.has(key(e))))issues.push('series-flat-mismatch:'+record.id);
}
if(issues.length){V.writeJson('reports/integrity-failures.json',issues);throw Error('Integrity checks failed; see reports/integrity-failures.json');}
V.saveAll(vault,state);
const unknown=v=>!v||['unknown','und','null','none','n/a'].includes(String(v).toLowerCase());
const unverified=r=>unknown(r.originalLanguage)||(r.category?.startsWith('tamil-dubbed')&&['ta','tam','tamil'].includes(r.originalLanguage))||(r.category&& !r.category.startsWith('tamil-dubbed')&&!['ta','tam','tamil'].includes(r.originalLanguage));
const count=list=>({records:list.length,movies:list.filter(r=>r.kind!=='series').length,series:list.filter(r=>r.kind==='series').length,
 embeds:list.reduce((n,r)=>n+r.embeds.length,0),episodes:list.reduce((n,r)=>n+(r.seasons||[]).reduce((v,s)=>v+s.episodes.length,0),0),
 missingTmdb:list.filter(r=>!r.tmdbId).length,missingPoster:list.filter(r=>!r.poster).length,unverified:list.filter(unverified).length});
const report={generatedAt:new Date().toISOString(),metadataJoined:joined,publishedRecovered,before:count(baseline),after:count(vault),
 preservedBaselineIds:baseline.length,preservedBaselineEmbeds:originalEmbeds,integrityIssues:0,
 sha256:createHash('sha256').update(fs.readFileSync(V.VAULT_FILE)).digest('hex'),
 unresolved:vault.filter(unverified).map(r=>({id:r.id,title:r.title,year:r.year,reason:r.metadataVerification?.reason||'metadata-pending',pageUrl:r.pageUrl})),
 limitations:['Verification concerns metadata identity, not copyright authorization or video playback.', 'Historical coverage and pending work are separately reported in historic-coverage.json.']};
V.writeJson('reports/recovery-summary.json',report);
console.log(JSON.stringify({...report,unresolved:report.unresolved.length},null,2));
