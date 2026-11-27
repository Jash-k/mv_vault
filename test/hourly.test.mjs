import test from 'node:test';
import assert from 'node:assert/strict';
import {runHourly,defaultHourlyListing} from '../src/hourly-core.mjs';
import {parseListing} from '../src/scrape.mjs';
const listing=defaultHourlyListing(2026);
const entry=(slug,kind='movie')=>`<a href="/${slug}-2026-tamil-${kind==='series'?'web-series':'movie'}/">${slug} (2026) NEW Cast: Example Original HD</a>`;
const movie={kind:'movie',embeds:[{quality:'1080p',url:'https://play.onestream.today/stream/page/123'}]};
const series=n=>({kind:'series',seasons:[{season:1,episodes:[{episode:n,embeds:[{quality:'1080p',url:`https://play.onestream.today/stream/page/${n}`}]}]}]});
const old=()=>({id:'known-2026',title:'known',year:2026,pageUrl:'https://moviesda34.com/known-2026-tamil-movie/',embeds:[{quality:'720p',url:'https://play.onestream.today/stream/page/99'}]});
function fixture(html,overrides={}){
 const calls=[],saved=[],vault=[old()],state={done:{}},queue={version:1,pending:{}};
 return {calls,saved,vault,state,queue,options:{listingUrl:listing,vault,state,queue,fetchPage:async url=>{calls.push(url);return {html};},walk:async url=>{calls.push(url);return movie;},persist:async changed=>{saved.push(changed);},...overrides}};
}
test('hourly scans only first listing page; adds unknowns before AND after known title',async()=>{
 const f=fixture(entry('one')+entry('known')+entry('two')+'<a href="?page=2">Next</a>');
 const before=structuredClone(f.vault[0]);const r=await runHourly(f.options);
 assert.equal(r.added,2);assert.equal(r.known,1);assert.equal(r.listingPages,1);
 assert.equal(f.calls.length,3);assert.ok(!f.calls.some(u=>u.includes('?')));assert.deepEqual(f.vault[0],before);
 assert.equal(Object.keys(f.queue.pending).length,0);assert.ok(f.vault.slice(1).every(r=>r.category==='tamil-movie'));
});
test('known-only listing requests no title pages and writes no data',async()=>{
 const f=fixture(entry('known'));const r=await runHourly(f.options);assert.equal(r.attempted,0);assert.equal(f.calls.length,1);assert.equal(f.saved.length,0);
});
test('failed new title survives leaving page one and retries later',async()=>{
 let time=1000000;const f=fixture(entry('lost'),{now:()=>time,walk:async()=>{throw Error('upstream unavailable');}});
 const r=await runHourly(f.options);assert.equal(r.failed,1);assert.equal(r.pending,1);assert.equal(f.vault.length,1);
 time+=3600000;
 const next=await runHourly({...f.options,fetchPage:async()=>({html:entry('known')}),walk:async()=>movie});
 assert.equal(next.added,1);assert.equal(next.pending,0);assert.equal(f.vault[1].title,'lost');
});
test('pending retry honors backoff and pending known record completed elsewhere is cleared',async()=>{
 const f=fixture(entry('later'),{now:()=>1000,walk:async()=>{throw Error('timeout');}});await runHourly(f.options);
 const r=await runHourly(f.options);assert.equal(r.attempted,0);
 f.vault.push({id:'later-2026',title:'later',year:2026,pageUrl:'https://moviesda34.com/later-2026-tamil-movie/',embeds:movie.embeds});
 assert.equal((await runHourly(f.options)).pending,0);
});
test('incomplete newly-added series retries and union-merges confirmed episodes only',async()=>{
 let time=1000000;const f=fixture(entry('show','series'),{now:()=>time,walk:async()=>({...series(1),incomplete:true})});
 const initial=await runHourly(f.options);assert.equal(initial.incomplete,1);assert.equal(f.vault[1].kind,'series');assert.equal(initial.pending,1);
 time+=3600000;
 const next=await runHourly({...f.options,walk:async()=>series(2)});assert.equal(next.pending,0);
 assert.deepEqual(f.vault[1].seasons[0].episodes.map(e=>e.episode),[1,2]);assert.equal(f.vault[1].embeds.length,2);
});
test('empty/blocked listing alerts without replacing vault or losing queue',async()=>{
 const f=fixture('<html>Maintenance</html>');const before=JSON.stringify(f.vault);const r=await runHourly(f.options);
 assert.match(r.listingError,/No title entries/);assert.equal(JSON.stringify(f.vault),before);assert.equal(f.saved.length,0);
});
test('max-items/budget retain unwalked new titles for future hours',async()=>{
 const f=fixture(entry('one')+entry('two'));const r=await runHourly({...f.options,maxItems:1});assert.equal(r.added,1);assert.equal(r.pending,1);
 const g=fixture(entry('one'));const b=await runHourly({...g.options,deadline:0});assert.equal(b.attempted,0);assert.equal(b.pending,1);
});
test('path identity ignores MoviesDa host aliases and series kind is discovered from mixed cards',async()=>{
 const f=fixture(entry('known')+entry('show','series'),{walk:async()=>series(1)});const r=await runHourly(f.options);assert.equal(r.added,1);assert.equal(r.known,1);assert.equal(f.vault[1].kind,'series');
 const rows=parseListing(entry('show','series'),listing,{base:new URL(listing).origin});assert.equal(rows[0].kind,'series');
});
test('hourly rejects paginated discovery input and malformed queue',async()=>{
 const f=fixture(entry('one'));await assert.rejects(runHourly({...f.options,listingUrl:listing+'?page=2'}),/root without/);
 await assert.rejects(runHourly({...f.options,queue:{version:0}}),/Invalid hourly queue/);
});
test('CLI writes real JSON/index/retry checkpoint and a second known-only run leaves data bytes untouched',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vault-hourly-cli-'));
 try {
  fs.mkdirSync(path.join(dir,'data'));fs.writeFileSync(path.join(dir,'data/vault.json'),JSON.stringify([old()]));fs.writeFileSync(path.join(dir,'data/state.json'),JSON.stringify({done:{}}));
  const mock=path.join(dir,'mock.mjs');
  fs.writeFileSync(mock,`globalThis.fetch=async url=>{const u=new URL(url);let html='';
   if(u.pathname==='/moviesda-tamil-movies-2026/')html='<a href="/one-2026-tamil-movie/">One (2026)</a><a href="?page=2">Next</a>';
   else if(u.pathname==='/one-2026-tamil-movie/')html='<a href="/one-2026-original-movie/">Original</a>';
   else if(u.pathname==='/one-2026-original-movie/')html='<a href="/one-2026-1080p-hd-movie/">1080p</a>';
   else if(u.pathname==='/one-2026-1080p-hd-movie/')html='<a href="/download/one-file/">download</a>';
   else if(u.pathname==='/download/one-file/')html='<a href="https://download.moviespage.xyz/download/file/123">file</a>';
   else if(u.hostname==='movies.downloadpage.xyz')html='<a href="https://play.onestream.today/stream/page/123">play</a>';
   else throw Error('Unexpected URL '+url);return new Response(html);};`);
  const cli=fileURLToPath(new URL('../src/hourly.mjs',import.meta.url));
  const run=()=>spawnSync(process.execPath,['--import',mock,cli,'--listing-url='+listing,'--budget-min=1'],{cwd:dir,encoding:'utf8',timeout:15000,env:{...process.env,DELAY_MS:'0',TRIES:'1'}});
  const first=run();assert.equal(first.status,0,first.stdout+first.stderr);
  const records=JSON.parse(fs.readFileSync(path.join(dir,'data/vault.json')));assert.equal(records.length,2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'data/index.json'))).length,2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'data/hourly.json'))).pending,{});
  const before=fs.readFileSync(path.join(dir,'data/vault.json'),'utf8');const second=run();assert.equal(second.status,0,second.stdout+second.stderr);
  assert.equal(fs.readFileSync(path.join(dir,'data/vault.json'),'utf8'),before);
  assert.ok(!fs.existsSync(path.join(dir,'data/.hourly.lock')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
