import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DELAY_MS='0';process.env.TRIES='1';
const {walkSeries}=await import('../src/scrape.mjs');
const {upsert,applyMetadata}=await import('../src/vault.mjs');
const base='https://moviezda.net';
const ep=(n,s=10)=>`<a href="/download/show-season-${s}-epi-${n}/">Episode ${n}</a>`;
const page=(p)=>`<a href="?page=${p}">${p}</a>`;
function mock(routes, fail=new Set()){
 const calls=[];
 globalThis.fetch=async url=>{
  const u=new URL(url);calls.push(u.href);
  if(fail.has(u.pathname))return new Response('',{status:404});
  let html=routes[u.pathname+u.search];
  if(u.pathname.startsWith('/download/show-')){const n=u.pathname.match(/epi-(\d+)/)[1];html=`<a href="https://download.moviespage.xyz/download/file/${n}">download</a>`;}
  if(u.hostname==='movies.downloadpage.xyz'){const n=u.pathname.split('/').at(-1);html=`<a href="https://play.onestream.today/stream/page/${n}">play</a>`;}
  assert.notEqual(html,undefined,`Unexpected request ${url}`);
  return new Response(html,{status:200});
 };return calls;
}
test('flat season pagination, loops, duplicate slugs, same-page season links',async()=>{
 const calls=mock({'/show-season-10-web-series/':ep(32)+page(2)+page(1),'/show-season-10-web-series/?page=2':ep(1)+ep(32)+page(1)+page(2)});
 const r=await walkSeries(base+'/show-season-10-web-series/');
 assert.deepEqual(r.seasons[0].episodes.map(e=>e.episode),[1,32]);assert.equal(r.seasons[0].season,10);assert.equal(r.incomplete,false);
 assert.equal(calls.filter(u=>u.includes('/download/show-season-10-epi-32')).length,1);
});
test('parent, season, quality pagination all read; preferred quality preserved',async()=>{
 mock({'/show-web-series/':'<a href="/show-season-2/">Season 2</a>',
 '/show-season-2/':'<a href="/show-season-2-720p/">720p</a>'+page(2),
 '/show-season-2/?page=2':ep(3,2),
 '/show-season-2-720p/':ep(1,2)+page(2),
 '/show-season-2-720p/?page=2':ep(2,2)+page(1)});
 const r=await walkSeries(base+'/show-web-series/');assert.deepEqual(r.seasons[0].episodes.map(e=>e.episode),[1,2,3]);assert.equal(r.seasons[0].episodes[0].embeds[0].quality,'720p');
});
test('failed page is incomplete, never silently a completed refresh',async()=>{
 mock({'/show-web-series/':ep(2)+page(2)},new Set(['/nothing']));
 const original=globalThis.fetch;globalThis.fetch=async u=>String(u).includes('?page=2')?new Response('',{status:404}):original(u);
 const r=await walkSeries(base+'/show-web-series/');assert.equal(r.incomplete,true);assert.equal(r.embeds.length,1);
});
test('deadline respected before network',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected')};
 await assert.rejects(walkSeries(base+'/show/',{deadline:Date.now()-1}),/budget/);assert.equal(calls,0);
});
test('pagination cap reports incomplete',async()=>{
 mock({'/show-web-series/':ep(1)+page(2)});const r=await walkSeries(base+'/show-web-series/',{maxEpisodePages:1});assert.equal(r.incomplete,true);
});
test('upsert merges new episodes without losing old or changing identity',()=>{
 const e=(episode)=>({episode,embeds:[{quality:'HD',url:`https://example.org/${episode}`}]});
 const v=[{id:'keep-id',title:'Show Season 10',year:2026,kind:'series',pageUrl:base+'/show/',embeds:[],seasons:[{season:10,episodes:[e(1)]}]}];
 upsert(v,{url:base+'/show/',title:'Show Season 10',year:2026},{kind:'series',seasons:[{season:10,episodes:[e(32)]}]});
 assert.equal(v.length,1);assert.equal(v[0].id,'keep-id');assert.deepEqual(v[0].seasons[0].episodes.map(e=>e.episode),[1,32]);assert.equal(v[0].embeds.length,2);
});
test('TMDB media type persisted without reshaping episode data',()=>{
 const r={title:'Show',kind:'series',seasons:[]};applyMetadata(r,{tmdbId:42,tmdbType:'tv',originalLanguage:'ta'});assert.equal(r.tmdbType,'tv');assert.equal(r.category,'tamil-series');assert.deepEqual(r.seasons,[]);
});
test('movie resolution folders still work after pagination filtering',async()=>{
 const {walkMovie}=await import('../src/scrape.mjs');
 mock({'/sample-tamil-movie/':'<a href="/sample-original-movie/">Original HD</a>',
 '/sample-original-movie/':'<a href="/sample-1080p-hd-movie/">1080p</a>',
 '/sample-1080p-hd-movie/':'<a href="/download/show-season-1-epi-1/">Sample</a>'});
 const r=await walkMovie(base+'/sample-tamil-movie/');assert.equal(r.kind,'movie');assert.equal(r.embeds.length,1);assert.equal(r.embeds[0].quality,'1080p');
});
test('TMDB language and category stay consistent when known language changes',()=>{
 const r={tmdbId:1,originalLanguage:'en',category:'tamil-dubbed-movie',categorySource:'tmdb'};
 applyMetadata(r,{tmdbId:1,tmdbType:'movie',originalLanguage:'ta'});
 assert.equal(r.originalLanguage,'ta');assert.equal(r.category,'tamil-movie');
});
