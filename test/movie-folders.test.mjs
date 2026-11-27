import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DELAY_MS='0';process.env.TRIES='1';
const {walkMovie}=await import('../src/scrape.mjs');
const base='https://moviesda36.com';
const a=(path,text='Original')=>`<a href="${path}">${text}</a>`;
function mock(routes,{failConfirm=false}={}){const calls=[];globalThis.fetch=async url=>{const u=new URL(url);calls.push(u.href);if(u.hostname==='movies.downloadpage.xyz')return new Response(failConfirm?'':`https://play.onestream.today/stream/page/${u.pathname.split('/').at(-1)}`,{status:failConfirm?503:200});if(!(u.pathname in routes))return new Response('',{status:404});return new Response(routes[u.pathname]);};return calls;}
const file=a('https://download.moviespage.xyz/download/file/123','Download');
test('extra Original layer reaches quality, slug and confirmed embed',async()=>{
 mock({'/film/':a('/film-original-hd/'),'/film-original-hd/':a('/film-original-moviesda/'),'/film-original-moviesda/':a('/film-720p-hd/','720p HD'),'/film-720p-hd/':a('/download/film/','Film'),'/download/film/':file});
 const r=await walkMovie(base+'/film/');assert.deepEqual(r.embeds,[{quality:'720p',url:'https://play.onestream.today/stream/page/123'}]);assert.ok(!r.incomplete);
});
test('downloads directly inside Original folder are collected; sample is excluded',async()=>{
 const calls=mock({'/film/':a('/film-original-hd/'),'/film-original-hd/':a('/download/film/','Film HD')+a('/download/film-sample/','Sample'),'/download/film/':file});
 const r=await walkMovie(base+'/film/');assert.equal(r.embeds.length,1);assert.ok(!calls.some(u=>u.includes('sample')));
});
test('downloads on item itself work and loops/navigation/external links are ignored',async()=>{
 const calls=mock({'/film/':a('/download/film/','Film')+a('/film-loop-hd/','HD')+a('/tamil-movies/a/','A')+a('https://evil.test/film-hd/','HD'),'/film-loop-hd/':a('/film/'),'/download/film/':file});
 const r=await walkMovie(base+'/film/');assert.equal(r.embeds.length,1);assert.equal(calls.filter(u=>u===base+'/film/').length,1);assert.ok(calls.every(u=>!u.includes('evil.test')&&!u.includes('/tamil-movies/')));
});
test('failed folder is incomplete, not a completed empty verdict',async()=>{
 mock({'/film/':a('/missing-hd/','HD')});const r=await walkMovie(base+'/film/');assert.equal(r.incomplete,true);assert.equal(r.embeds.length,0);
});
test('depth limit marks incomplete and bounds folder requests',async()=>{
 const routes={};for(let i=0;i<10;i++)routes[`/film-${i}-hd/`]=a(`/film-${i+1}-hd/`,'HD');const calls=mock(routes);const r=await walkMovie(base+'/film-0-hd/');assert.equal(r.incomplete,true);assert.ok(calls.length<=6);
});
test('expired deadline does not request children',async()=>{
 const calls=mock({});const r=await walkMovie(base+'/film/',{html:a('/film-hd/','HD'),deadline:Date.now()-1});assert.equal(r.incomplete,true);assert.equal(calls.length,0);
});
test('failed confirmation marks incomplete; never fabricates embed',async()=>{
 mock({'/film/':a('/download/film/','Film'),'/download/film/':file},{failConfirm:true});const r=await walkMovie(base+'/film/');assert.equal(r.incomplete,true);assert.equal(r.embeds.length,0);
});
test('genuinely empty template stays complete and empty',async()=>{
 mock({'/film/':'<h1>Film</h1>'});const r=await walkMovie(base+'/film/');assert.equal(r.embeds.length,0);assert.ok(!r.incomplete);
});
