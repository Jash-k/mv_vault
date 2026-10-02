import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { fetchWithRetry, fetchBounded, retryAfterMs, hostDownUntil, httpStats } from '../src/http.js';
import { walkItem } from '../src/walk.js';
import { checkEmbed } from '../src/liveness.js';
import { maintain, freshMaintenance } from '../src/maintenance.js';
import { freshProgress } from '../src/pipeline-core.js';
const read = f => fs.readFileSync(new URL(`fixtures/${f}.html`,import.meta.url),'utf8');
const base='https://moviesda34.com';
test('fixture-based movie walk traverses item/group/quality/file/confirm',async()=>{
 const pages=new Map([[base+'/demo-2026-movie/',read('movie-item')],[base+'/demo-hd/',read('movie-group')],[base+'/demo-720p/',read('movie-quality')],['https://movies.downloadpage.xyz/download/demo-720p/',read('movie-file')],['https://movies.downloadpage.xyz/download/page/42',read('movie-confirm')]]);
 const walk={failures:new Set(),get:async u=>{assert(pages.has(u),u);return pages.get(u)}};
 const result=await walkItem(base+'/demo-2026-movie/',{walk});assert.equal(result.embeds.length,1);assert.equal(result.embeds[0].quality,'720p');assert(result.poster.endsWith('demo-2026.jpg'));
});
test('unreadable fixture item throws instead of becoming empty',async()=>{
 await assert.rejects(walkItem(base+'/demo-2026-movie/',{walk:{failures:new Set(),get:async()=>{throw Error('offline')}}}),/unreadable/);
});
test('fixture series walk finds a new episode without testing old embed liveness',async()=>{
 const pages=new Map([[base+'/demo-web-series/','<a href="/demo-season-01/">Season 1</a>'],[base+'/demo-season-01/','<a href="/demo-season-01-720p/">720p</a>'],[base+'/demo-season-01-720p/','<a href="/download/demo-season-01-epi-02/">Episode 2</a>'],[base+'/download/demo-season-01-epi-02/',read('movie-file')],['https://movies.downloadpage.xyz/download/page/42',read('movie-confirm')]]);
 const result=await walkItem(base+'/demo-web-series/',{walk:{failures:new Set(),get:async u=>{assert(pages.has(u),u);return pages.get(u)}}});
 assert.equal(result.seasons[0].episodes[0].episode,2);assert.equal(result.seasons[0].episodes[0].embeds[0].quality,'720p');
});
test('Retry-After accepts seconds and HTTP dates',()=>{
 assert.equal(retryAfterMs({headers:new Headers({'retry-after':'5'})}),5000);
 const ms=retryAfterMs({headers:new Headers({'retry-after':new Date(Date.now()+20000).toUTCString()})});assert(ms>18000&&ms<=20000);
});
test('404 requests do not park a healthy host; redirect to unapproved host is blocked',async()=>{
 const old=process.env.VAULT_ALLOWED_HOSTS;process.env.VAULT_ALLOWED_HOSTS='127.0.0.1';
 const server=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'http://unapproved.invalid/path'});res.end();}else{res.writeHead(404);res.end('missing');}}).listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
 try{for(let i=0;i<10;i++)await assert.rejects(fetchWithRetry(url+'/missing'));assert.equal(hostDownUntil(url),0);await assert.rejects(fetchBounded(url+'/redirect'),/Unapproved/);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.VAULT_ALLOWED_HOSTS;else process.env.VAULT_ALLOWED_HOSTS=old;}
});
test('expired network deadline stops before issuing a request',async()=>{
 const old=process.env.VAULT_DEADLINE_MS;process.env.VAULT_DEADLINE_MS='1';try{await assert.rejects(fetchWithRetry(base+'/x'),/deadline/);}finally{if(old===undefined)delete process.env.VAULT_DEADLINE_MS;else process.env.VAULT_DEADLINE_MS=old;}
});
test('request budget rejects extra requests',async()=>{
 const old=process.env.VAULT_MAX_REQUESTS;process.env.VAULT_MAX_REQUESTS=String(httpStats.requests);try{await assert.rejects(fetchBounded(base+'/x'),/budget/);}finally{if(old===undefined)delete process.env.VAULT_MAX_REQUESTS;else process.env.VAULT_MAX_REQUESTS=old;}
});
test('liveness distinguishes player, empty, challenge and transport failure',async()=>{
 const original=globalThis.fetch,url='https://play.onestream.today/stream/page/42';
 try {
 globalThis.fetch=async()=>new Response('<html><source src="https://media.invalid/a.mp4">'+' '.repeat(500));assert.equal((await checkEmbed(url)).state,'live');
 globalThis.fetch=async()=>new Response('');assert.equal((await checkEmbed(url)).state,'dead');
 globalThis.fetch=async()=>new Response('<title>Just a moment</title>'+' '.repeat(500));assert.equal((await checkEmbed(url)).state,'unknown');
 globalThis.fetch=async()=>new Response('not a player'.repeat(100));assert.equal((await checkEmbed(url)).state,'unknown');
 globalThis.fetch=async()=>{throw Error('offline')};assert.equal((await checkEmbed(url)).state,'unknown');
 }finally{globalThis.fetch=original;}
});
test('absent posters get cooldown and do not starve later records',async()=>{
 const original=globalThis.fetch,calls=[];
 const vault=['first','second'].map(id=>({id,title:id,year:2026,pageUrl:base+`/${id}-2026-movie/`,poster:'',embeds:[]}));
 const maintenance=freshMaintenance(),progress=freshProgress('releases'),config={posterLimit:1,metadataLimit:0,livenessRecords:0};
 try{
 globalThis.fetch=async url=>{calls.push(String(url));return new Response(null,{status:404})};
 const args={vault,progress,aliases:{},config,maintenance,liveness:{},deadline:Date.now()+100000,report:{postersFilled:0,metadataFilled:0,embedsChecked:0,deadLinks:0,pruned:0},mode:'posters'};
 await maintain(args);assert(maintenance.posters.first.nextAt>Date.now());
 await maintain(args);assert(maintenance.posters.second.nextAt>Date.now());assert(calls.some(u=>u.includes('second')));
 }finally{globalThis.fetch=original;}
});
