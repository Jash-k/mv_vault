import { getHtml, parseListing, walkItem, embedCount, WALK_VERSION } from './scrape.mjs';
import * as V from './vault.mjs';

export const defaultHourlyListing = (year = new Date().getUTCFullYear()) => `https://moviesda36.com/moviesda-tamil-movies-${year}/`;
const tamilRecord = record => { try { return !new URL(record.pageUrl).hostname.includes('isaidub'); } catch { return false; } };
const safeError = error => String(error?.message || error).slice(0,240);

/** Single discovery page, unknown title walks only. Dependencies injected for offline tests. */
export async function runHourly({ vault, state, queue, listingUrl=defaultHourlyListing(), deadline=Date.now()+10*60_000,
  maxItems=30, active=()=>true, fetchPage=getHtml, parse=parseListing, walk=walkItem,
  persist=async()=>{}, log=()=>{}, now=()=>Date.now() }) {
  if(!Array.isArray(vault)||!vault.length)throw Error('A nonempty existing vault is required; hourly must not initialize/replace the catalogue.');
  const listing=new URL(listingUrl);
  if(listing.protocol!=='https:' || listing.search || listing.hash || !/^\/moviesda-tamil-movies-\d{4}\/$/.test(listing.pathname))throw Error('Use the HTTPS year listing root without pagination/query/hash.');
  if(queue.version!==1 || !queue.pending || typeof queue.pending!=='object' || Array.isArray(queue.pending))throw Error('Invalid hourly queue; preserve it and repair manually.');
  const summary={listingUrl,listingPages:0,discovered:0,known:0,enqueued:0,attempted:0,added:0,merged:0,empty:0,failed:0,incomplete:0,pending:0,listingError:null};
  let queueDirty=false;
  const known = item => vault.find(r=>tamilRecord(r)&&V.pathOf(r.pageUrl)===item.path)
    || vault.find(r=>tamilRecord(r)&&r.id===V.idFor(item.title,item.year)&&(r.kind==='series'?'series':'movie')===item.kind);
  try {
    const {html}=await fetchPage(listing.href);summary.listingPages=1;
    // Deliberately no discover()/nextListingUrl(): page 2 and unrelated listings are never fetched.
    const rows=parse(html,listing.href,{base:listing.origin});
    if(!rows.length)throw Error('No title entries found; source may be unavailable or markup changed.');
    summary.discovered=rows.length;
    for(const row of rows){
      const identity=V.titleFor(row);if(!identity)continue;
      const item={...row,...identity,path:V.pathOf(row.url),url:new URL(V.pathOf(row.url),listing.origin).href};
      const existing=known(item);
      if(existing){summary.known++;continue;}
      if(!queue.pending[item.path]){queue.pending[item.path]={item,attempts:0,nextRetryAt:0,firstSeenAt:new Date(now()).toISOString()};summary.enqueued++;queueDirty=true;}
    }
  } catch(error){summary.listingError=safeError(error);log(`Listing unavailable: ${summary.listingError}; retained pending work may still retry.`);}
  if(queueDirty)await persist(false);
  const jobs=Object.entries(queue.pending).sort((a,b)=>(a[1].lastAttemptAt||0)-(b[1].lastAttemptAt||0));
  for(const [path,job] of jobs){
    if(!active() || now()>=deadline || summary.attempted>=maxItems)break;
    // Paths, not old hostnames, are durable. Retry an off-page title on the configured live host.
    const item={...job.item,path,url:new URL(path,listing.origin).href};
    if(!path.startsWith('/')||path.startsWith('//'))throw Error('Unsafe queued source path');
    const stored=known(item);
    if(stored && !(job.incomplete && job.recordId===stored.id)){
      delete queue.pending[path];await persist(false);continue;
    }
    if(Number(job.nextRetryAt||0)>now())continue;
    summary.attempted++;job.attempts=Number(job.attempts||0)+1;job.lastAttemptAt=now();
    try {
      const walked=await walk(item.url,{deadline,maxEpisodePages:100});
      const count=embedCount(walked);
      if(!count){summary.empty++;throw Error('No confirmed playback embeds yet');}
      const result=V.upsert(vault,item,walked,new Date(now()).toISOString());
      if(!result.record)throw Error('No confirmed record to save');
      if(!result.record.originalLanguage)V.applySiteCategory(result.record,false);
      summary[result.action==='added'?'added':'merged']++;
      state.done ||= {};
      state.done[item.url]={at:new Date(now()).toISOString(),embeds:count,kind:walked.kind,v:WALK_VERSION,incomplete:!!walked.incomplete};
      if(walked.incomplete){job.incomplete=true;job.recordId=result.record.id;job.nextRetryAt=now()+45*60_000;summary.incomplete++;}
      else delete queue.pending[path];
      // Checkpoint each confirmed title. Partial series only merge confirmed episodes.
      await persist(true);log(`${result.action}: ${item.title} (${item.year}) · ${count} embeds${walked.incomplete?' · retry incomplete walk':''}`);
    } catch(error){
      queue.pending[path] ||= job;
      summary.failed++;job.error=safeError(error);job.nextRetryAt=now()+Math.min(24*60,30*2**Math.min(job.attempts-1,5))*60_000;
      await persist(false);log(`pending: ${item.title} · ${job.error}`);
    }
  }
  summary.pending=Object.keys(queue.pending).length;
  summary.stoppedByBudget=!active()||now()>=deadline;
  return summary;
}
