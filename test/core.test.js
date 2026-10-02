import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshProgress, validateProgress, enqueue, selectDue, nextAfter, parseListing, discoverArchive, discoverReleases, processJobs, seedReleaseRefresh, HOURS } from '../src/pipeline-core.js';
import { markEmpty, markFailed, markPartial, upsertRecord, recordFromWalk } from '../src/store.js';
import { retryStatus, partialStatus } from '../src/schedule.js';
import { dueForRetry, assessDiscovery, loadPageAliases } from '../src/delta.js';
import { refreshRecord, pruneDeadEmbeds } from '../src/refresh.js';
import { chooseMatch } from '../src/tmdb.js';
import { posterFromHtml, verifyPoster } from '../src/posters.js';
import { isSeriesUrl } from '../src/walk.js';
import { kindOfPath, isItemPath } from '../src/sections.js';
const config = JSON.parse(fs.readFileSync(new URL('../config/workflows.json', import.meta.url)));
const origin = 'https://moviesda34.com';
const embed = id => ({ url: `https://play.onestream.today/stream/page/${id}`, quality: '720p' });
const movie = (id = 'demo-2026') => ({ id, title: 'Demo', year: 2026, pageUrl: `${origin}/${id}-movie/`, embeds: [embed(1)], poster: '', rating: 0, tmdbId: 0, imdbId: '' });
const html = paths => `<html><title>Tamil movies</title><body>${paths.map(p => `<div class='f'><a href='/${p}-movie/'>Download Now</a></div>`).join('')}</body></html>`;
const deadline = Date.now() + 100000;

test('all five retry rungs including the 30-day timestamp execute', () => {
 const state = { done: {} }, url = movie().pageUrl;
 for (const hours of [12,24,72,168,720]) {
  const before = Date.now(); markEmpty(state,url);
  assert(Math.abs(Date.parse(state.done[url].retryAfter)-before-hours*HOURS)<1000);
  assert.equal(retryStatus(state.done[url], Date.parse(state.done[url].retryAfter)+1).due,true);
 }
});
test('repeated failures never retire an item', () => {
 const s={done:{}}; for(let i=0;i<20;i++) markFailed(s,'url');
 assert.equal(s.done.url.dead,undefined);
 assert.equal(retryStatus(s.done.url,Date.now()+48*HOURS).due,true);
});
test('legacy dead pages enter probation again',()=> assert.equal(retryStatus({empty:true,dead:true,at:new Date(0).toISOString()},Date.now()).due,true));
test('partial initial attempt is not a recheck and remains recoverable',()=>{
 const s={done:{}};markPartial(s,'u');assert.equal(s.done.u.rechecks,0);
 for(let i=0;i<4;i++)markPartial(s,'u');assert.equal(partialStatus(s.done.u,Date.now()+200*HOURS).due,true);
});
test('failed stored records are selected for identity-locked retry',()=>{
 const m=movie(),s={done:{}};markFailed(s,m.pageUrl);
 const rows=dueForRetry({state:s,vault:[m]},Date.now()+48*HOURS);assert.equal(rows.length,1);assert.equal(rows[0].id,m.id);assert(rows[0].locked);
});
test('zero-result sweep is not healthy',()=>assert(assessDiscovery({mode:'sweep',sources:{sections:0,listings:48}}).degraded));
test('alias cadence config is preserved',()=>assert.equal(loadPageAliases().refreshHours,24));
test('listing parser handles single quotes and generic labels',()=>{
 const r=parseListing(html(['demo-2026']),origin,1);assert.equal(r.items.length,1);assert.equal(r.items[0].label,'Download Now');
});
test('listing parser rejects challenges and ambiguous empty pages',()=>{
 assert.throws(()=>parseListing('<title>Just a moment</title>',origin,1));
 assert.throws(()=>parseListing('<body>Welcome</body>',origin,3));
 assert.equal(parseListing('<body>No movies found</body>',origin,3).ended,true);
 assert.throws(()=>parseListing('<body>No movies found</body>',origin,1));
});
test('listing parser ignores external and navigation links',()=>{
 const r=parseListing(html(['demo-2026'])+'<a href="https://evil.example/evil-movie/">bad</a><a href="/tamil-2026-movies/">index</a>',origin);assert.equal(r.items.length,1);
});
test('series path classification agrees across discovery and walker',()=>{
 for(const p of ['/test-season-10/','/test-web-series/','/test-web-series-moviesda/']) {assert.equal(kindOfPath(p),'series');assert(isSeriesUrl(origin+p));}
});
test('enqueue is idempotent by path and preserves stored identity',()=>{
 const p=freshProgress('releases'),m=movie();enqueue(p,[{url:m.pageUrl}], [m]);enqueue(p,[{url:m.pageUrl}], [m]);assert.equal(Object.keys(p.jobs).length,1);assert.equal(Object.values(p.jobs)[0].id,m.id);
});
test('different pages cannot silently collide by record ID',()=>{
 const p=freshProgress('releases'),m=movie();enqueue(p,[{url:`${origin}/demo-2026-tamil-movie/`},{url:`${origin}/other-2026-movie/`}],[m]);assert.equal(Object.keys(p.collisions).length,1);assert.equal(Object.keys(p.jobs).length,1);
});
test('explicit aliases retain every alternative path with the same identity',()=>{
 const p=freshProgress('releases'),m=movie(),aliases={mergeInto:{'/other-movie/':m.id,'/third-movie/':m.id}};
 enqueue(p,Object.keys(aliases.mergeInto).map(path=>({url:origin+path})),[m],aliases);
 assert.equal(Object.keys(p.jobs).length,2);assert(Object.values(p.jobs).every(j=>j.id===m.id));
});
test('skip paths are respected',()=>{
 const p=freshProgress('archive');enqueue(p,[{url:movie().pageUrl}],[],{skipPaths:['/demo-2026-movie/']});assert.equal(Object.keys(p.jobs).length,0);
});
test('invalid progress fails instead of silently restarting A–Z',()=>{
 assert.throws(()=>validateProgress({mode:'archive'},'archive'));
 const p=freshProgress('archive');p.archive.page=-1;assert.throws(()=>validateProgress(p,'archive'));
});
test('fair scheduler reserves capacity for series, fresh, retries and refreshes',()=>{
 const p=freshProgress('releases');let n=0;
 for(const [kind,attempts,status,locked] of [['movie',0,'pending',false],['series',1,'done',true],['movie',1,'failed',false],['movie',1,'done',true]]) {
  for(let i=0;i<20;i++){const key='/j'+n+++'/';p.jobs[key]={path:key,kind,attempts,status,locked,nextAt:0};}
 }
 const jobs=selectDue(p,5);assert(jobs.some(j=>j.kind==='series'));assert(jobs.some(j=>j.status==='failed'));assert(jobs.some(j=>j.status==='done'&&j.kind==='movie'));
});
test('archive page failure does not advance cursor',async()=>{
 const p=freshProgress('archive');p.archive.letter='h';p.archive.page=4;
 await assert.rejects(discoverArchive({progress:p,vault:[],aliases:{},config,fetchListing:async()=>{throw Error('offline')},save:()=>{},deadline}));
 assert.equal(p.archive.letter,'h');assert.equal(p.archive.page,4);
});
test('archive persists page items and resumes next page without losing pending work',async()=>{
 const p=freshProgress('archive');let snapshot;
 await discoverArchive({progress:p,vault:[],aliases:{},config:{...config,archiveListingPages:1},fetchListing:async()=>html(['alpha-2026','beta-2026']),save:()=>{snapshot=structuredClone(p)},deadline});
 assert.equal(snapshot.archive.page,2);assert.equal(Object.keys(snapshot.jobs).length,2);
 const q=validateProgress(snapshot,'archive');const calls=[];
 await discoverArchive({progress:q,vault:[],aliases:{},config:{...config,archiveListingPages:1},fetchListing:async url=>{calls.push(url);return html(['gamma-2026'])},save:()=>{},deadline});
 assert(calls[0].endsWith('?page=2'));assert.equal(Object.keys(q.jobs).length,3);
});
test('archive repeated last page advances letter, and Z completes a cycle',async()=>{
 const p=freshProgress('archive');p.archive.letter='z';p.archive.page=2;p.archive.fingerprints=[parseListing(html(['last-2026']),origin).fingerprint];
 await discoverArchive({progress:p,vault:[],aliases:{},config,fetchListing:async()=>html(['last-2026']),save:()=>{},deadline});
 assert(p.archive.completedAt);assert(p.archive.nextCycleAt);
});
test('archive never advances when its deadline has expired',async()=>{
 const p=freshProgress('archive');await discoverArchive({progress:p,vault:[],aliases:{},config,fetchListing:async()=>{throw Error('should not fetch')},save:()=>{},deadline:1});assert.equal(p.archive.page,1);
});
test('current-year and January previous-year transition are automatic',()=>{
 const p=freshProgress('releases');assert.deepEqual(seedReleaseRefresh(p,[],{},config,Date.UTC(2027,0,2)),[2027,2026]);assert.deepEqual(seedReleaseRefresh(p,[],{},config,Date.UTC(2027,5,2)),[2027]);
});
test('ongoing series remain queued after leaving the latest listing',()=>{
 const p=freshProgress('releases'),m={...movie(),kind:'series',year:2020};seedReleaseRefresh(p,[m],{},config);assert.equal(Object.keys(p.jobs).length,1);
});
test('release discovery does not request A–Z or sitemap and reports listing errors',async()=>{
 const p=freshProgress('releases'),calls=[];
 const problems=await discoverReleases({progress:p,vault:[],aliases:{},config:{...config,releaseYear:2026,previousYearGraceMonths:0},fetchListing:async url=>{calls.push(url);throw Error('offline')},save:()=>{},deadline});
 assert.equal(problems.length,2);assert(calls.every(u=>u.includes('tamil-2026-movies')||u.includes('tamil-web-series-download')));
});
test('series refresh accepts a seasons-only walk result',async()=>{
 const walked={kind:'series',seasons:[{season:1,episodes:[{episode:1,embeds:[embed(2)]}]}]};
 const result=await refreshRecord(movie(),{walkPage:async()=>walked});assert.equal(result.walked,walked);assert.equal(result.tried[0].embeds,1);
});
test('series union regenerates the flattened episode tree',()=>{
 const entry={...movie(),url:movie().pageUrl};
 const a=recordFromWalk(entry,{kind:'series',seasons:[{season:1,episodes:[{episode:1,embeds:[embed(1)]}]}]},{id:entry.id});
 const b=recordFromWalk(entry,{kind:'series',seasons:[{season:1,episodes:[{episode:2,embeds:[embed(2)]}]}]},{id:entry.id});
 const vault=[a];upsertRecord(vault,b);assert.equal(vault[0].embeds.length,2);assert.equal(vault[0].seasons[0].episodes.length,2);
});
test('same title and episode numbers alone do not merge different series',()=>{
 const make=(id,url)=>({...movie(id),kind:'series',title:'Same Season 1',embeds:[embed(url)],seasons:[{season:1,episodes:[1,2,3].map(episode=>({episode,embeds:[embed(url+episode)]}))}]});
 const v=[make('same-a',100)];upsertRecord(v,make('same-b',200));assert.equal(v.length,2);
});
test('dead pruning refuses to empty a record',()=>{
 const m=movie();assert(pruneDeadEmbeds(m,[m.embeds[0].url]).keptAll);assert.equal(m.embeds.length,1);
});
test('successful processing stores record and advances matching queue state together',async()=>{
 const p=freshProgress('archive'),vault=[],state={done:{}};enqueue(p,[{url:movie().pageUrl}],[]);let saved;
 const counts=await processJobs({progress:p,vault,state,config,mode:'archive',walkPage:async()=>({kind:'movie',embeds:[embed(1)]}),save:()=>{saved={p:structuredClone(p),v:structuredClone(vault)}},deadline});
 assert.equal(counts.added,1);assert.equal(vault.length,1);assert.equal(Object.values(saved.p.jobs)[0].id,saved.v[0].id);
});
test('global source outage never makes empty results terminal',async()=>{
 const p=freshProgress('archive'),state={done:{}};enqueue(p,[{url:movie().pageUrl}],[]);
 await processJobs({progress:p,vault:[],state,config,mode:'archive',walkPage:async()=>({kind:'movie',embeds:[]}),save:()=>{},deadline,healthy:false});
 const job=Object.values(p.jobs)[0];assert.equal(job.status,'unknown');assert.equal(job.failures,0);assert.equal(state.done[job.url].dead,undefined);
});
test('healthy empty backlog advances ordinary empty ladder, not global failure ladder',async()=>{
 const p=freshProgress('archive'),state={done:{}};enqueue(p,[{url:movie().pageUrl}],[]);
 const r=await processJobs({progress:p,vault:[],state,config,mode:'archive',walkPage:async()=>({kind:'movie',embeds:[]}),save:()=>{},deadline});assert.equal(r.empty,1);assert.equal(Object.values(p.jobs)[0].emptyAttempts,1);
});
test('jobs not started before deadline remain pending',async()=>{
 const p=freshProgress('archive');enqueue(p,[{url:movie().pageUrl}],[]);await processJobs({progress:p,vault:[],state:{done:{}},config,mode:'archive',walkPage:async()=>{throw Error('should not call')},save:()=>{},deadline:1});assert.equal(Object.values(p.jobs)[0].attempts,0);
});
test('TMDB exact match rejects fuzzy, wrong year and ambiguous results',()=>{
 assert.equal(chooseMatch([{id:1,title:'Different',release_date:'2026-01-01'}],{title:'Demo',year:2026}),null);
 assert.equal(chooseMatch([{id:1,title:'Demo',release_date:'2025-01-01'}],{title:'Demo',year:2026}),null);
 assert.equal(chooseMatch([{id:1,title:'Demo'},{id:2,title:'Demo'}],{title:'Demo',year:0}),null);
 assert.equal(chooseMatch([{id:1,name:'Demo',first_air_date:'2026-01-01'}],{title:'Demo',year:2026,kind:'series'}).id,1);
});
test('poster extraction normalizes absolute URLs without double slash',()=>assert.equal(posterFromHtml('<img src="https://old.example/uploads/posters/a.jpg">'), 'https://moviezda.net/uploads/posters/a.jpg'));
test('only recognized soft-404 redirect means poster absent',async()=>{
 const res=location=>async()=>new Response(null,{status:302,headers:{location}});
 assert.equal((await verifyPoster(origin+'/p.jpg',{fetchImpl:res('/movies.php')})).state,'absent');
 assert.equal((await verifyPoster(origin+'/p.jpg',{fetchImpl:res('/cdn/new.jpg')})).state,'unknown');
});

test('all stored legacy page shapes remain discoverable',()=>{
 const vault=JSON.parse(fs.readFileSync(new URL('../data/vault.json',import.meta.url)));
 assert(vault.every(m=>isItemPath(new URL(m.pageUrl).pathname)));
});
