#!/usr/bin/env node
import fs from 'node:fs';
import { updateTopOrder, applySourceOrder } from './source-order.mjs';
import { runHourly, defaultHourlyListing } from './hourly-core.mjs';
import * as V from './vault.mjs';
const arg=(key,fallback)=>process.argv.find(x=>x.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
const minutes=Number(arg('budget-min',10)),maxItems=Number(arg('max-items',30));
if(!Number.isFinite(minutes)||minutes<=0||minutes>15||!Number.isInteger(maxItems)||maxItems<1||maxItems>100)throw Error('Use budget-min 0..15 (positive), max-items 1..100');
const listingUrl=arg('listing-url',process.env.HOURLY_LISTING_URL||defaultHourlyListing());
fs.mkdirSync('data',{recursive:true});fs.mkdirSync('reports',{recursive:true});
if(fs.existsSync('data/.historic.lock')||fs.existsSync('data/.order.lock'))throw Error('Historical writer is active. Run only one catalogue writer at a time.');
const lock='data/.hourly.lock';
let fd;
try {fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,String(process.pid));}
catch {throw Error('Hourly writer lock exists. Verify no writer is active before removing it.');}
let stopping=false;
const stop=()=>{stopping=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
try {
 const vault=V.loadVault(),state=V.loadState();
 const file='data/hourly.json';
 const queue=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{version:1,pending:{}};
 let previous=JSON.stringify(queue);
 let listingRows=null;
 const summary=await runHourly({vault,state,queue,listingUrl,maxItems,deadline:Date.now()+minutes*60_000,active:()=>!stopping,
  onListing:async rows=>{listingRows=rows;},
  persist:async catalogChanged=>{
    if(catalogChanged)V.saveAll(vault,state);
    const serialized=JSON.stringify(queue);
    if(serialized!==previous){V.writeJson(file,queue);previous=serialized;}
  },log:line=>console.log(new Date().toISOString(),line)});
 if(listingRows && fs.existsSync('data/source-order.json')) {
  const orderFile='data/source-order.json',old=fs.readFileSync(orderFile,'utf8'),order=JSON.parse(old);
  updateTopOrder(order,listingUrl,listingRows);
  if(applySourceOrder(vault,order))V.saveAll(vault,state);
  if(JSON.stringify(JSON.parse(old))!==JSON.stringify(order))V.writeJson(orderFile,order);
 }
 V.writeJson('reports/hourly-latest.json',{generatedAt:new Date().toISOString(),...summary,totalRecords:vault.length});
 console.log(JSON.stringify(summary,null,2));
 // Discovery failure must be visible even if retained pending titles succeeded.
 if(summary.listingError)process.exitCode=1;
} finally {
 fs.closeSync(fd);fs.unlinkSync(lock);
 process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
