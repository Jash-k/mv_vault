import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TMDB_KEYS='fixture-key';process.env.TRIES='1';
const {sourceEvidence,enrichRecord}=await import('../src/metadata-evidence.mjs');
test('source parser extracts credits, never treats Tamil dub language as original',async()=>{
 globalThis.fetch=async()=>new Response('<li><strong>Movie:</strong><span>Example (2026)</span></li><li><strong>Director:</strong><span>Director One</span></li><li><strong>Starring:</strong><span>Actor One, Actor Two</span></li><li><strong>Language:</strong><span>Tamil</span></li>');
 const e=await sourceEvidence({pageUrl:'https://moviesda34.com/example-tamil-movie/'});assert.equal(e.sourceYear,2026);assert.equal(e.sourceUrl,'https://moviezda.net/example-tamil-movie/');assert.deepEqual(e.cast,['Actor One','Actor Two']);assert.equal(e.originalLanguage,undefined);
});
test('inaccessible source cross-check returns unavailable instead of accepting a candidate',async()=>{
 globalThis.fetch=async url=>{
  const u=new URL(url);if(u.hostname!=='api.themoviedb.org')return new Response('',{status:403});
  const d={id:1,title:'Example',release_date:'2026-01-01',original_language:'en'};
  return Response.json(u.pathname.includes('/search/')?{results:[d],total_pages:1}:d);
 };
 assert.equal(await enrichRecord({title:'Example',year:2026,pageUrl:'https://moviesda34.com/example-tamil-movie/'}),undefined);
});
test('missing source URL is unavailable, not an uncaught exception',async()=>{
 const e=await sourceEvidence({});assert.equal(e.available,false);
});
