import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TMDB_KEYS = 'fixture-key';
const { enrich, normalise } = await import('../src/tmdb.mjs');
const make = (id, title, year=2023, extra={}) => ({id,title,original_title:title,release_date:`${year}-01-01`,original_language:'ta',...extra});
function api(hits, details, opts={}) {
  globalThis.fetch = async (url) => {
    const u=new URL(url);
    if(opts.fail) return new Response('', {status:503});
    if(u.pathname.includes('/search/')) return Response.json({results: typeof hits==='function'?hits(u):hits, total_pages:opts.pages||1});
    return Response.json(details[Number(u.pathname.split('/').at(-1))]||null);
  };
}
test('Unicode title normalization is nonempty and preserves decimal titles',()=>{
 assert.equal(normalise("Tom Clancy’s Jack Ryan"),normalise('Tom Clancys Jack Ryan'));
 assert.equal(normalise('Mr. & Mrs. Smith'),normalise('Mr and Mrs Smith'));
 assert.notEqual(normalise('தமிழ்'), '');assert.notEqual(normalise('2.0'),normalise('20'));
});
test('unique exact movie title/year',async()=>{
 const d=make(1,'Sample');api([d],{1:d});assert.equal((await enrich({title:'Sample',year:2023})).tmdbId,1);
});
test('different release year is not accepted',async()=>{
 const d=make(1,'Sample',2022);api([d],{1:d});assert.equal(await enrich({title:'Sample',year:2023,kind:'series'}),null);
});
test('same-title candidates stay ambiguous',async()=>{
 const a=make(1,'Sample'),b=make(2,'Sample');api([a,b],{1:a,2:b});assert.equal(await enrich({title:'Sample',year:2023}),null);
});
test('official alternative title can match',async()=>{
 const d=make(1,'Canonical',2023,{alternative_titles:{titles:[{title:'Official Alias'}]}});api([d],{1:d});assert.equal((await enrich({title:'Official Alias',year:2023})).tmdbId,1);
});
test('compact search is actually queried and still exact-matched',async()=>{
 const d=make(1,'Businessman',2012);api(u=>u.searchParams.get('query')==='businessman'?[d]:[],{1:d});assert.equal((await enrich({title:'Business Man',year:2012})).tmdbId,1);
});
test('TV matches season-air year rather than first-air year',async()=>{
 const d={id:1,name:'Show',first_air_date:'2016-01-01',seasons:[{season_number:3,air_date:'2019-01-01'}],original_language:'en'};
 api([d],{1:d});assert.equal((await enrich({title:'Show Season 3',year:2019,kind:'series',seasons:[{season:3}]})).match,'exact-title-season-year');
 assert.equal(await enrich({title:'Show',year:2019,kind:'series',seasons:[{season:2}]}),null);
});
test('regional reality show is not guessed without language evidence',async()=>{
 const d={id:1,name:'Bigg Boss',first_air_date:'2017-01-01',seasons:[{season_number:10,air_date:'2026-01-01'}],original_language:'te'};
 api([d],{1:d});assert.equal(await enrich({title:'Bigg Boss Season 10',year:2026,kind:'series'}),null);
 assert.equal(await enrich({title:'Bigg Boss Season 10',year:2026,kind:'series',originalLanguage:'ta'}),null);
});
test('HTTP failure and truncated search are unavailable, never a miss',async()=>{
 api([],{}, {fail:true});assert.equal(await enrich({title:'Sample',year:2023}),undefined);
 api([],{}, {pages:6});assert.equal(await enrich({title:'Sample',year:2023}),undefined);
});
test('suspect stored ID does not overwrite metadata when verification fails',async()=>{
 api([],{99:make(99,'Unrelated',2023)});assert.equal(await enrich({title:'Sample',year:2023,tmdbId:99,verifyIds:true}),null);
});

test('credit corroboration needs two cast or director+cast; no fuzzy short titles',async()=>{
 const {creditEvidence,titleSimilarity}=await import('../src/tmdb.mjs');
 const d={credits:{cast:[{name:'Actor One'},{name:'Actor Two'}],crew:[{job:'Director',name:'Director One'}]}};
 assert.equal(creditEvidence(d,{cast:['Actor One','Actor Two']}).strong,true);
 assert.equal(creditEvidence(d,{cast:['Actor One']}).strong,false);
 assert.equal(creditEvidence(d,{cast:['Actor One'],directors:['Director One']}).strong,true);
 assert.equal(creditEvidence(d,{cast:['Other One','Other Two']}).contradiction,true);
 assert.equal(titleSimilarity('Dhoom 2','Dhoom 3'),0);
 assert.equal(titleSimilarity('Rats','Cats'),0);
 assert.ok(titleSimilarity('Aayiram Porkaasukal','Aayiram Porkaasugal')>0.84);
});
test('single-season series keeps its season poster on future enrichment',async()=>{
 const d={id:1,name:'Show',first_air_date:'2016-01-01',poster_path:'/generic.jpg',seasons:[{season_number:3,air_date:'2019-01-01',poster_path:'/season3.jpg'}],original_language:'en'};
 api([d],{1:d});const r=await enrich({title:'Show Season 3',year:2019,kind:'series',seasons:[{season:3}]});assert.equal(r.poster,'https://image.tmdb.org/t/p/w500/season3.jpg');
 const later=await enrich({title:'Show Season 3',year:2019,kind:'series',seasons:[{season:3}],tmdbId:1});assert.equal(later.poster,r.poster);
});
