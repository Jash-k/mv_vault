import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const runner=path.resolve('src/run.mjs');
function run(args,{complete=false,knownHours=5.5}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vault-regression-'));fs.mkdirSync(path.join(dir,'data'));
 const record={id:'bigg-boss-season-10',title:'Bigg Boss Season 10',year:2026,kind:'series',pageUrl:'https://moviesda34.com/bigg-boss-season-10-web-series/',embeds:[{quality:'HD',url:'https://play.onestream.today/stream/page/1',season:10,episode:1}],seasons:[{season:10,episodes:[{episode:1,embeds:[{quality:'HD',url:'https://play.onestream.today/stream/page/1'}]}]}],poster:complete?'https://example.org/p.jpg':'',rating:complete?8:0,tmdbId:complete?42:0,imdbId:complete?'tt42':'',category:complete?'tamil-series':'',categorySource:complete?'tmdb':'site',originalLanguage:complete?'ta':''};
 const original=JSON.stringify([record]);fs.writeFileSync(path.join(dir,'data/vault.json'),original);
 const state={done:{[record.pageUrl]:{at:new Date(Date.now()-knownHours*3600000).toISOString(),embeds:1,kind:'series',v:3}},tmdbMiss:{[record.id]:new Date().toISOString()}};
 fs.writeFileSync(path.join(dir,'data/state.json'),JSON.stringify(state));
 fs.writeFileSync(path.join(dir,'mock.mjs'),`globalThis.fetch=async (url)=>{
 const u=new URL(url);let html='';
 if(u.hostname==='api.themoviedb.org')return Response.json({id:42,name:'Bigg Boss',original_language:'ta',first_air_date:'2017-06-25',poster_path:'/new.jpg',vote_average:8,external_ids:{imdb_id:'tt42'}});
 if(u.pathname==='/bigg-boss-season-10-web-series/')html='<a href="/download/show-season-10-epi-2/">Episode 2</a>';
 if(u.pathname.includes('/download/show-season'))html='<a href="https://download.moviespage.xyz/download/file/2">file</a>';
 if(u.hostname==='movies.downloadpage.xyz')html='<a href="https://play.onestream.today/stream/page/2">play</a>';
 return new Response(html);
};`);
 const child=spawnSync(process.execPath,['--import',path.join(dir,'mock.mjs'),runner,...args],{cwd:dir,encoding:'utf8',env:{...process.env,TMDB_KEYS:args.includes('--verify-ids')?'fixture-key':'',TMDB_API_KEY:'',DELAY_MS:'0',TRIES:'1'},timeout:15000});
 const after=fs.readFileSync(path.join(dir,'data/vault.json'),'utf8');fs.rmSync(dir,{recursive:true,force:true});
 assert.equal(child.status,0,child.stdout+child.stderr);return {output:child.stdout,original,after};
}
test('default release refreshes canonical current-year series absent from listings after 5h',()=>{
 const r=run(['--mode=releases','--dry','--no-link-check','--tmdb-limit=0']);
 assert.match(r.output,/\+1 episode/);assert.match(r.output,/series refresh 1/);assert.equal(r.after,r.original);
});
test('recent successful series walk is skipped',()=>{
 const r=run(['--mode=releases','--dry','--no-link-check','--tmdb-limit=0'],{knownHours:1});assert.match(r.output,/items walked\s+0/);assert.equal(r.after,r.original);
});
test('verify-ids includes complete records and overrides recent misses',()=>{
 const r=run(['--mode=enrich','--verify-ids','--dry'],{complete:true});assert.match(r.output,/eligible now: 1/);assert.equal(r.after,r.original);
});
