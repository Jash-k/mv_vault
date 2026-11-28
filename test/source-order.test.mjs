import test from 'node:test';import assert from 'node:assert/strict';
import {collectSourceOrder,updateFullOrder,updateTopOrder,applySourceOrder,listingIdentity} from '../src/source-order.mjs';
const url='https://moviesda36.com/moviesda-tamil-movies-2026/';
const row=p=>({url:`https://moviesda36.com/${p}/`});const initial=()=>({version:1,years:{}});
test('complete scan preserves source sequence, overlap deduplication and pagination',async()=>{
 const calls=[];const s=await collectSourceOrder(url,{fetchPage:async u=>{calls.push(u);return {html:u.includes('page=2')?'second':'first'};},parse:h=>h==='first'?[row('movie'),row('series')]:[row('series'),row('older')],next:h=>h==='first'?url+'?page=2':''});
 assert.deepEqual(s.paths,['/movie/','/series/','/older/']);assert.equal(s.pages,2);assert.equal(calls.length,2);
});
test('failed empty repeated pages and deadline fail closed',async()=>{
 for(const parse of [()=>[],()=>[row('same')]])await assert.rejects(collectSourceOrder(url,{fetchPage:async()=>({html:''}),parse,next:()=>url+'?page=2'}));
 await assert.rejects(collectSourceOrder(url,{deadline:Date.now()-1}),/incomplete/);
 await assert.rejects(collectSourceOrder(url,{fetchPage:async()=>{throw Error('HTTP 503');}}),/503/);
});
test('rollover keeps prior year and newest wins overlaps without touching embeds',()=>{
 const store=initial();updateFullOrder(store,{year:2026,url,paths:['/b/','/a/']});updateFullOrder(store,{year:2027,url:url.replace('2026','2027'),paths:['/c/','/a/']});
 const v=['a','b','c','other'].map(id=>({id,pageUrl:`https://moviesda34.com/${id}/`,embeds:[{url:'https://example.org/keep'}]}));
 const old=JSON.stringify(v.map(r=>r.embeds));assert.equal(applySourceOrder(v,store),3);assert.deepEqual(v[0].sourceOrder,{year:2027,position:1});assert.equal(v[1].sourceOrder.year,2026);assert.equal(JSON.stringify(v.map(r=>r.embeds)),old);assert.equal(applySourceOrder(v,store),0);
});
test('hourly reranks known titles, keeps tail and cannot activate new year',()=>{
 const store=initial();updateFullOrder(store,{year:2026,url,paths:['/a/','/b/','/c/']});assert.equal(updateTopOrder(store,url,[row('b'),row('new')]),true);assert.deepEqual(store.years[2026].paths,['/b/','/new/','/a/','/c/']);const before=JSON.stringify(store);assert.equal(updateTopOrder(store,url.replace('2026','2027'),[row('x')]),false);assert.equal(JSON.stringify(store),before);
});
test('full sync removes stale ranks without deleting records; dubbed paths excluded',()=>{
 const store=initial();updateFullOrder(store,{year:2026,url,paths:['/a/']});const v=[{pageUrl:'https://moviesda36.com/gone/',sourceOrder:{year:2026,position:0}},{pageUrl:'https://isaidub.green/a/'}];applySourceOrder(v,store);assert.equal(v.length,2);assert.ok(!v[0].sourceOrder&&!v[1].sourceOrder);
});
test('listing configuration validates root and year',()=>{
 assert.equal(listingIdentity(url).year,2026);assert.throws(()=>listingIdentity(url+'?page=2'));assert.throws(()=>listingIdentity('http://example.com/moviesda-tamil-movies-2026/'));
});
