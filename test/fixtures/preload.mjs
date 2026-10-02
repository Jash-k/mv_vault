// Entirely offline fetch fixture, loaded only by the end-to-end test child.
import fs from 'node:fs';
const vault=JSON.parse(fs.readFileSync(process.env.FIXTURE_VAULT));
const record=vault[0],id=record.embeds[0].url.split('/').pop(),quality=record.embeds[0].quality;
globalThis.fetch=async input=>{
 const url=new URL(input);
 let body;
 if(url.pathname.includes('/tamil-movies/'))body=`<html><a href="${record.pageUrl}">${record.title} (${record.year})</a></html>`;
 else if(url.pathname===new URL(record.pageUrl).pathname)body='<a href="/fixture-hd/">HD</a>';
 else if(url.pathname==='/fixture-hd/')body=`<a href="/fixture-${quality}/">${quality}</a>`;
 else if(url.pathname===`/fixture-${quality}/`)body='<a href="https://movies.downloadpage.xyz/download/fixture/">Download</a>';
 else if(url.pathname==='/download/fixture/')body=`<a href="/download/file/${id}">Download</a>`;
 else if(url.pathname===`/download/page/${id}`)body=`<a href="${record.embeds[0].url}">Play</a>`;
 else throw new Error(`Unmocked network request blocked: ${url}`);
 return new Response(body,{status:200,headers:{'content-type':'text/html'}});
};
