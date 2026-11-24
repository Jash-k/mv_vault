#!/usr/bin/env node
/** Recover regression-lost IDs only when live TMDB still corroborates exact title + year. */
import fs from 'node:fs';
import { normalise, creditEvidence } from './tmdb.mjs';
const previous = process.argv.find(x=>x.startsWith('--previous='))?.slice(11);
if(!previous)throw Error('Supply --previous=/path/to/previous/published/vault.json');
const old=JSON.parse(fs.readFileSync(previous));
const current=new Map(JSON.parse(fs.readFileSync('data/vault.json')).map(r=>[r.id,r]));
const keys=String(process.env.TMDB_KEYS||process.env.TMDB_API_KEY||'').split(',').map(v=>v.trim()).filter(Boolean);
if(!keys.length)throw Error('Private TMDB credential required');
const jobs=old.filter(r=>{const n=current.get(r.id);return n&&!n.tmdbId&&r.tmdbId&&n.title===r.title&&n.year===r.year&&(n.kind||'movie')===(r.kind||'movie')&&new URL(n.pageUrl).pathname===new URL(r.pageUrl).pathname;});
let cursor=0;const results=[];
async function worker(){while(cursor<jobs.length){const index=cursor++, record=jobs[index];
 const type=record.tmdbType||(record.kind==='series'?'tv':'movie');
 try{
  const r=await fetch(`https://api.themoviedb.org/3/${type}/${record.tmdbId}?append_to_response=external_ids,alternative_titles,translations,credits,aggregate_credits&api_key=${keys[index%keys.length]}`,{signal:AbortSignal.timeout(12000)});
  if(!r.ok){await r.body?.cancel();results.push({id:record.id,status:'unavailable',reason:'http-'+r.status});continue;}
  const d=await r.json();
  const query=record.title.replace(/\s*(?:\(|-)?\s*season\s*\d+\s*\)?$/i,'').trim();
  const titles=[d.title,d.name,d.original_title,d.original_name,...(d.alternative_titles?.titles||d.alternative_titles?.results||[]).map(x=>x.title),...(d.translations?.translations||[]).flatMap(x=>[x.data?.title,x.data?.name])].filter(Boolean);
  const exact=titles.some(t=>normalise(t)===normalise(query));
  const year=Number(String(type==='tv'?d.first_air_date:d.release_date).slice(0,4));
  const declared=Number(record.title.match(/season\s*(\d+)/i)?.[1]||0);
  const seasons=(record.seasons||[]).map(s=>Number(s.season));
  const season=declared||(seasons.length===1?seasons[0]:0);
  const seasonYear=Number(String(d.seasons?.find(s=>s.season_number===season)?.air_date||'').slice(0,4));
  const yearSafe=record.year&&(year===record.year||(type==='tv'&&season&&seasonYear===record.year));
  const credits=record.sourceMetadata?.available?creditEvidence(d,record.sourceMetadata):null;
  if(!exact||!yearSafe||!d.original_language||credits?.contradiction||(record.originalLanguage&&record.originalLanguage!==d.original_language)){
    results.push({id:record.id,status:'review',reason:'live-identity-not-exact'});continue;
  }
  const seasonPoster=type==='tv'?d.seasons?.find(s=>s.season_number===season)?.poster_path:'';
  const poster=seasonPoster||d.poster_path;
  results.push({id:record.id,status:'matched',checkedAt:new Date().toISOString(),meta:{tmdbId:d.id,tmdbType:type,tmdbTitle:d.title||d.name,originalYear:year,
   originalLanguage:d.original_language,poster:poster?'https://image.tmdb.org/t/p/w500'+poster:'',rating:Number(d.vote_average)||0,imdbId:d.external_ids?.imdb_id||'',match:'published-id-live-exact-title-year'}});
 }catch{results.push({id:record.id,status:'unavailable',reason:'request-failed'});}
 if(results.length%100===0)fs.writeFileSync('reports/recovered-published-metadata.json',JSON.stringify({generatedAt:new Date().toISOString(),selected:jobs.length,results},null,1)+'\n');
}}
await Promise.all(Array.from({length:6},worker));
fs.writeFileSync('reports/recovered-published-metadata.json',JSON.stringify({generatedAt:new Date().toISOString(),selected:jobs.length,results},null,1)+'\n');
console.log(JSON.stringify({selected:jobs.length,counts:results.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{})}));
