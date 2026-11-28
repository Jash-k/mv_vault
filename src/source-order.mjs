import { getHtml, parseListing, nextListingUrl } from './scrape.mjs';
import { defaultHourlyListing } from './hourly-core.mjs';
export function listingIdentity(value=process.env.HOURLY_LISTING_URL||defaultHourlyListing()) {
 const u=new URL(value);
 if(u.protocol!=='https:'||u.search||u.hash||!/^\/moviesda-tamil-movies-\d{4}\/$/.test(u.pathname))throw Error('Use the HTTPS year-listing root without query/hash.');
 return {url:u.href,year:Number(u.pathname.match(/(\d{4})/)[1])};
}
export function pathKey(value){try{return new URL(value,'https://moviesda36.com').pathname.replace(/\/+$/,'')+'/';}catch{return '';}}
export function validateOrder(store){
 if(store.version!==1||!store.years||typeof store.years!=='object'||Array.isArray(store.years))throw Error('Invalid source-order checkpoint; preserve and repair it.');
 for(const [year,s] of Object.entries(store.years))if(!/^\d{4}$/.test(year)||!Array.isArray(s.paths)||!s.paths.length||new Set(s.paths).size!==s.paths.length||s.paths.some(p=>typeof p!=='string'||!p.startsWith('/')))throw Error('Invalid source-order snapshot.');
 return store;
}
// Commit nothing until every linked listing page has succeeded. Never fetch title pages.
export async function collectSourceOrder(listingUrl,{fetchPage=getHtml,parse=parseListing,next=nextListingUrl,maxPages=250,deadline=Date.now()+20*60000}={}){
 const identity=listingIdentity(listingUrl),paths=[],seenPaths=new Set(),seenPages=new Set();let url=identity.url;
 while(url){
  if(Date.now()>=deadline||seenPages.size>=maxPages)throw Error('Order scan incomplete: time/page budget exhausted. Previous ranking retained.');
  if(seenPages.has(url))throw Error('Order pagination loop; previous ranking retained.');
  seenPages.add(url);const {html}=await fetchPage(url);const rows=parse(html,url,{base:new URL(identity.url).origin});
  if(!rows.length)throw Error(`Empty/unavailable listing page: ${url}`);
  let fresh=0;for(const r of rows){const path=pathKey(r.url);if(!seenPaths.has(path)){seenPaths.add(path);paths.push(path);fresh++;}}
  if(!fresh)throw Error('Repeated listing page; previous ranking retained.');
  const following=next(html,url);
  if(following){const current=new URL(url),n=new URL(following);const page=u=>Number(u.searchParams.get('page')||u.searchParams.get('get-page')||u.pathname.match(/\/(\d+)\/?$/)?.[1]||1);if(page(n)!==page(current)+1)throw Error('Pagination skipped a page; previous ranking retained.');const root=n.pathname.replace(/\/\d+\/?$/,'/');if(n.origin!==new URL(identity.url).origin||root!==new URL(identity.url).pathname)throw Error('Unsafe pagination target.');}
  url=following;
 }
 return {...identity,paths,pages:seenPages.size};
}
export function updateFullOrder(store,snapshot){
 validateOrder(store);
 // Store prior-year snapshots; newest successfully synced year wins for overlaps.
 if(!snapshot.paths?.length)throw Error('Cannot publish empty order.');
 const old=store.years[String(snapshot.year)];
 if(old && snapshot.paths.length < old.paths.length*0.8)throw Error('Listing shrank by more than 20%; investigate before replacing the saved ranking.');
 store.years[String(snapshot.year)]={url:snapshot.url,paths:snapshot.paths};return store;
}
export function updateTopOrder(store,listingUrl,rows){
 validateOrder(store);const {year,url}=listingIdentity(listingUrl),old=store.years[String(year)];
 // First page alone cannot activate a new year/source: wait for a complete scan.
 if(!old||old.url!==url)return false;
 const top=[...new Set(rows.map(r=>pathKey(r.url)))];if(!top.length)return false;
 old.paths=[...top,...old.paths.filter(p=>!top.includes(p))];return true;
}
export function applySourceOrder(vault,store){
 validateOrder(store);const positions=new Map();
 for(const year of Object.keys(store.years).sort((a,b)=>Number(b)-Number(a))){store.years[year].paths.forEach((path,position)=>{if(!positions.has(path))positions.set(path,{year:Number(year),position});});}
 let changed=0;
 for(const row of vault){
  let host='';try{host=new URL(row.pageUrl).hostname;}catch{}
  const rank=/^(?:www\.)?(?:moviesda[^.]*|moviezda)\./i.test(host)?positions.get(pathKey(row.pageUrl)):undefined;
  if(JSON.stringify(row.sourceOrder)!==JSON.stringify(rank)){if(rank)row.sourceOrder={...rank};else delete row.sourceOrder;changed++;}
 }
 return changed;
}
