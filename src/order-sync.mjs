#!/usr/bin/env node
import fs from 'node:fs';
import { collectSourceOrder, updateFullOrder, applySourceOrder, listingIdentity } from './source-order.mjs';
import * as V from './vault.mjs';
const arg=k=>process.argv.find(x=>x.startsWith(`--${k}=`))?.slice(k.length+3);
fs.mkdirSync('data',{recursive:true});
if(fs.existsSync('data/.historic.lock')||fs.existsSync('data/.hourly.lock'))throw Error('Another catalogue writer is active.');
const lock='data/.order.lock';const fd=fs.openSync(lock,'wx');
try {
const listing=listingIdentity(arg('listing-url')).url;
const file='data/source-order.json';
const store=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{version:1,years:{}};
const vault=V.loadVault(),state=V.loadState();
const snapshot=await collectSourceOrder(listing);
updateFullOrder(store,snapshot);const changed=applySourceOrder(vault,store);
if(changed)V.saveAll(vault,state);
const serialized=JSON.stringify(store,null,2)+'\n';
if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==serialized)V.writeJson(file,store);
console.log(JSON.stringify({listing,year:snapshot.year,pages:snapshot.pages,positions:snapshot.paths.length,rankedRecordsChanged:changed},null,2));

} finally {fs.closeSync(fd);fs.unlinkSync(lock);}
