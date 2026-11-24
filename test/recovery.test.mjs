import test from 'node:test';
import assert from 'node:assert/strict';
import { nextListingUrl, discover, probeEmbed, parseListing, walkDubbed } from '../src/scrape.mjs';
import { applyMetadata } from '../src/vault.mjs';

test('pagination follows path-number routes and query routes, never unrelated folders',()=>{
 assert.equal(nextListingUrl('<a href="/tamil-atoz-dubbed-movies/a/2">»</a>','https://isaidub.green/tamil-atoz-dubbed-movies/a'),'https://isaidub.green/tamil-atoz-dubbed-movies/a/2');
 assert.equal(nextListingUrl('<a href="?get-page=3">3</a><a href="?get-page=1">1</a>','https://moviesda.ski/shows/?get-page=2'),'https://moviesda.ski/shows/?get-page=3');
 assert.equal(nextListingUrl('<a href="/other/?page=2">2</a>','https://moviesda.ski/shows/'),'');
});
test('historical discovery reaches actual second page rather than repeating first page',async()=>{
 const calls=[];
 globalThis.fetch=async url=>{calls.push(String(url));return new Response(String(url).endsWith('/2')?'<a href="/movie/two-2026-tamil-dubbed-movie/">Two (2026)</a>':'<a href="/movie/one-2026-tamil-dubbed-movie/">One (2026)</a><a href="/letters/a/2">»</a>');};
 const rows=await discover('/letters/a',{host:'https://isaidub.green',canonBase:'https://isaidub.green',dubbed:true,maxPages:5});
 assert.equal(rows.length,2);assert.equal(calls.length,2);assert.ok(calls[1].endsWith('/2'));
});
test('collection landing pages are discovered only when explicitly requested',()=>{
 const html='<a href="/movie/franchise-collections/">Franchise</a>';
 assert.equal(parseListing(html,'https://isaidub.green/',{dubbed:true}).length,0);
 assert.equal(parseListing(html,'https://isaidub.green/',{dubbed:true,includeCollections:true}).length,1);
});
test('health never promotes generic error/challenge pages or removes transient failures',async()=>{
 for(const html of ['<title>Generic page</title>'+'x'.repeat(500),'<title>Just a moment...</title>'+'x'.repeat(500),'<h1>Temporarily unavailable</h1>','']){
  globalThis.fetch=async()=>new Response(html);
  assert.equal((await probeEmbed('https://example.test/player')).verdict,'unknown');
 }
 globalThis.fetch=async()=>new Response('<video><source src="https://cdn.example/video.mp4"></video>');
 assert.equal((await probeEmbed('https://example.test/player')).verdict,'alive');
 globalThis.fetch=async()=>new Response('',{status:410});
 assert.equal((await probeEmbed('https://example.test/player')).verdict,'dead');
});
test('canonical metadata fields reach published record and never change episode identity',()=>{
 const record={id:'owned-demo',embeds:[{url:'https://example.test/1',season:1,episode:1}],seasons:[]};
 const before=JSON.stringify(record.embeds);
 applyMetadata(record,{tmdbId:1,tmdbType:'tv',tmdbTitle:'Canonical Demo',originalYear:2020,originalLanguage:'ta'});
 assert.equal(record.tmdbTitle,'Canonical Demo');assert.equal(record.originalYear,2020);assert.equal(record.category,'tamil-series');assert.equal(JSON.stringify(record.embeds),before);
});
test('dubbed walk respects elapsed budget before network',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};
 await assert.rejects(walkDubbed('https://isaidub.green/movie/show/',{deadline:Date.now()-1}),/budget/);
 assert.equal(calls,0);
});
