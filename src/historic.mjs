#!/usr/bin/env node
/** Explicit, resumable historical audit. Single writer; never deletes old links. */
import fs from 'node:fs';
import { LIVE, CANON, DUB, getHtml, parseListing, walkItem, walkDubbed, parseDubLabel, embedCount, sleep, WALK_VERSION, nextListingUrl } from './scrape.mjs';
import * as V from './vault.mjs';
import { runMetadataWorker } from './metadata-worker.mjs';

const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.split('=').slice(1).join('=') ?? fallback;
const minutes = Number(arg('budget-min', 60));
const metadataMinutes = Number(arg('metadata-budget-min', 20));
if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120 || !Number.isFinite(metadataMinutes) || metadataMinutes < 0 || metadataMinutes > 40) throw Error('Use crawl budget 0..120 and metadata budget 0..40 minutes');
const parallel = Math.min(4, Math.max(1, Number(arg('concurrency', 3))));
const deadline = Date.now() + minutes * 60000;
fs.mkdirSync('reports', { recursive: true });
const lock = 'data/.historic.lock';
let fd;
try { fd = fs.openSync(lock, 'wx'); } catch { throw Error('Historical writer already locked. Verify no writer is active before removing data/.historic.lock.'); }
fs.writeFileSync(fd, String(process.pid));
const vault = V.loadVault(), state = V.loadState();
const file = 'data/historic.json';
const checkpoint = fs.existsSync(file) && !process.argv.includes('--new-pass') ? JSON.parse(fs.readFileSync(file)) : {
  startedAt: new Date().toISOString(), baselineRecords: vault.length,
  listings: {}, queue: {}, outcomes: {}, errors: [],
};
function save() {
  checkpoint.updatedAt = new Date().toISOString();
  V.saveAll(vault, state); V.writeJson(file, checkpoint);
}
const keyOf = item => `${new URL(item.url).hostname.includes('isaidub') ? 'dub' : 'tamil'}:${V.pathOf(item.url)}`;
function enqueue(item) { checkpoint.queue[keyOf(item)] ||= item; }
const log = line => console.log(new Date().toISOString(), line);
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
const active = () => !stopping && Date.now() < deadline;
async function discoverListing(task) {
  const key = task.source + ':' + task.path;
  const progress = checkpoint.listings[key] ||= { nextPage: 1, status: 'pending', pages: 0, found: 0, fingerprints: [] };
  if (progress.status === 'complete') return;
  const seen = new Set(progress.fingerprints);
  for (let page = progress.nextPage; page <= task.maxPages && active(); page++) {
    const base = task.source === 'dub' ? DUB : LIVE;
    const path = progress.nextUrl || task.path + (page > 1 ? `${task.path.includes('?') ? '&' : '?'}${task.param || 'page'}=${page}` : '');
    try {
      const url = path.startsWith('http') ? path : base + path;
      const { html } = await getHtml(url);
      const rows = parseListing(html, url, { base: task.source === 'dub' ? DUB : CANON, dubbed: task.source === 'dub', includeCollections: task.path.includes('collections') });
      const fingerprint = rows.map(r => r.path).sort().join('|');
      progress.pages++;
      if (!rows.length || seen.has(fingerprint)) {
        progress.status = 'complete'; progress.endReason = rows.length ? 'repeated-page' : 'empty-page';
        break;
      }
      seen.add(fingerprint); progress.fingerprints.push(fingerprint);
      for (const row of rows) enqueue({ ...row, source: task.source });
      progress.found += rows.length; progress.nextPage = page + 1;
      const next = nextListingUrl(html, url);
      if (!next) { progress.status = 'complete'; progress.endReason = 'no-next-link'; break; }
      progress.nextUrl = next;
      if (page === task.maxPages) progress.status = 'page-cap';
      // Persist listing cursor without repeatedly rewriting the large vault.
      V.writeJson(file, checkpoint);
      await sleep(180);
    } catch (error) {
      progress.status = 'failed'; progress.error = String(error.message).slice(0, 220);
      log(`listing failed ${key}; cursor retained`); break;
    }
  }
  log(`listing ${key}: ${progress.found} refs, ${progress.status}`);
}

try {
  // Full alphabetical discovery plus the separate series and newest folders.
  const tasks = [
    { source: 'tamil', path: '/tamil-web-series-download/', param: 'get-page', maxPages: 150 },
    { source: 'tamil', path: `/tamil-${new Date().getUTCFullYear()}-movies/`, maxPages: 100 },
    ...[...'abcdefghijklmnopqrstuvwxyz'].flatMap(l => [
      { source: 'tamil', path: `/tamil-movies/${l}/`, maxPages: 150 },
      { source: 'dub', path: `/tamil-atoz-dubbed-movies/${l}`, maxPages: 150 },
    ]),
    { source: 'dub', path: '/tamil-dubbed-hollywood-movies/', maxPages: 300 },
    { source: 'dub', path: '/recent-updates/', maxPages: 150 },
    { source: 'dub', path: '/movie/tamil-dubbed-movies-collections/', param: 'get-page', maxPages: 100 },
  ];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, parallel) }, async () => {
    while (cursor < tasks.length && active()) await discoverListing(tasks[cursor++]);
  }));
  // Collection landing pages require expansion, not a movie walk.
  for (const [key, item] of Object.entries(checkpoint.queue)) {
    if (item.source !== 'dub' || !/-collections?\/$/.test(item.path) || !active()) continue;
    await discoverListing({ source: 'dub', path: item.path, maxPages: 30 });
    checkpoint.outcomes[key] = { status: 'collection-expanded', at: new Date().toISOString() };
  }
  // Stored series may no longer appear in current listings; audit them too.
  for (const r of vault.filter(r => r.kind === 'series')) {
    const source = new URL(r.pageUrl).hostname.includes('isaidub') ? 'dub' : 'tamil';
    enqueue({ path: V.pathOf(r.pageUrl), url: r.pageUrl, label: r.title, title: r.title, year: r.year, kind: 'series', source });
  }
  const byPath = new Map(vault.map(r => [keyOf({ url: r.pageUrl }), r]));
  const jobs = [];
  for (const [key, item] of Object.entries(checkpoint.queue)) {
    const done = checkpoint.outcomes[key];
    if (done && ['complete', 'stored-movie', 'collection-expanded'].includes(done.status)) continue;
    const stored = byPath.get(key);
    if (stored && stored.kind !== 'series' && item.kind !== 'series') {
      checkpoint.outcomes[key] = { status: 'stored-movie', at: new Date().toISOString() }; continue;
    }
    jobs.push([key, item, stored]);
  }
  const yearOf = job => Number(job[2]?.year || job[1].year || String(job[1].label || job[1].path).match(/(?:19|20)\d{2}/)?.[0] || 0);
  jobs.sort((a,b) => Number(Boolean(a[2])) - Number(Boolean(b[2])) || yearOf(b)-yearOf(a) || Number(b[1].kind === 'series') - Number(a[1].kind === 'series')); 
  log(`walking ${jobs.length} missing/series pages; ${vault.length} stored records retained`);
  let next = 0, sinceSave = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < jobs.length && active()) {
      const [key,item,stored] = jobs[next++];
      const old = checkpoint.outcomes[key];
      try {
        const fetchUrl = item.source === 'dub' ? DUB + item.path : LIVE + item.path;
        const walked = item.source === 'dub'
          ? await walkDubbed(fetchUrl, { deadline, maxEpisodePages: 100, title: item.label })
          : await walkItem(fetchUrl, { deadline, maxEpisodePages: 100 });
        const count = embedCount(walked);
        let result;
        if (count) {
          const parsed = stored ? { title: stored.title, year: stored.year } : item.source === 'dub' ? parseDubLabel(item.label,item.path) : V.titleFor(item);
          if (!parsed?.title) throw Error('No safe title');
          result = V.upsert(vault, { ...item, ...parsed }, walked);
          if (item.source === 'dub' && result.record && !result.record.originalLanguage) V.applySiteCategory(result.record, true);
          state.done[item.url] = { at: new Date().toISOString(), embeds: count, kind: walked.kind, incomplete: Boolean(walked.incomplete), v: WALK_VERSION };
        }
        checkpoint.outcomes[key] = { status: walked.incomplete ? 'incomplete' : count ? 'complete' : 'empty',
          at: new Date().toISOString(), attempts: (old?.attempts || 0)+1, embeds: count, action: result?.action || 'none',
          ...(result?.record ? { id: result.record.id } : {}) };
        log(`${checkpoint.outcomes[key].status} ${item.path}: ${count} embeds${result ? ' '+result.action : ''}`);
      } catch (error) {
        checkpoint.outcomes[key] = { status: 'failed', at: new Date().toISOString(), attempts: (old?.attempts || 0)+1, error: String(error.message).slice(0,220) };
        log(`failed ${item.path}`);
      }
      if (++sinceSave >= 10) { save(); sinceSave = 0; }
      await sleep(180);
    }
  }));
  save();
  const report = {
    generatedAt: new Date().toISOString(), baselineRecords: checkpoint.baselineRecords, records: vault.length,
    listings: Object.fromEntries(Object.entries(checkpoint.listings).map(([k,v]) => [k, { ...v, fingerprints: undefined }])),
    discoveredPaths: Object.keys(checkpoint.queue).length,
    outcomes: Object.values(checkpoint.outcomes).reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{}),
    pending: Object.keys(checkpoint.queue).filter(k=>!checkpoint.outcomes[k]).length,
    limitations: ['Only accessible source listings are discoverable.', 'Stored movie pages are retained, not all re-downloaded.', 'Embed confirmation is not video playback verification.'],
  };
  report.discoveryComplete = tasks.every(t => checkpoint.listings[t.source+':'+t.path]?.status === 'complete');
  report.walkComplete = !report.pending && !Object.entries(report.outcomes).some(([k,v])=>['failed','empty','incomplete'].includes(k)&&v);
  V.writeJson('reports/historic-coverage.json', report);
  if (metadataMinutes > 0 && !stopping) {
    await runMetadataWorker(vault,state,{ budgetMin: metadataMinutes, limit: 0, concurrency: 4,
      retryMisses: true, save: () => V.saveAll(vault,state), log, reportPath:'reports/metadata.json' });
  }
  save(); log('historical pass checkpointed; see reports/historic-coverage.json');
} finally {
  fs.closeSync(fd); fs.unlinkSync(lock);
}
