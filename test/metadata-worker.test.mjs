import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMetadataQueue, runMetadataWorker } from '../src/metadata-worker.mjs';
import { rememberMetadata, dueForMetadata, METADATA_VERSION } from '../src/metadata-state.mjs';
import { needsMetadata, mergeStates, upsert } from '../src/vault.mjs';

const record = (id, extra = {}) => ({ id, title: id, year: 2026,
  pageUrl: `https://example.org/${id}/`, embeds: [{ url: `https://example.org/embed/${id}` }], ...extra });
const complete = (id, extra = {}) => record(id, { tmdbId: 10, originalLanguage: 'ta', category: 'tamil-movie',
  categorySource: 'tmdb', poster: 'poster', imdbId: 'tt10', rating: 0, ...extra });
const opts = { hasKey: () => true, keysDown: () => false, overrides: {}, budgetMin: 1, concurrency: 1 };

test('legacy misses and stored skipped movies enter durable queue, language matters but votes do not', () => {
  const a = record('legacy', { category: 'tamil-movie', categorySource: 'site', poster: 'site' });
  const b = complete('no-language', { originalLanguage: '' });
  const c = complete('no-votes');
  const state = { tmdbMiss: { legacy: new Date().toISOString() } };
  assert.equal(needsMetadata(a), true);
  assert.equal(needsMetadata(b), true);
  assert.equal(needsMetadata(c), false);
  const q = buildMetadataQueue([a, b, c], state).queue;
  assert.deepEqual(new Set(q.map(r => r.id)), new Set(['legacy', 'no-language', 'no-votes']));
  assert.ok(q.indexOf(a) < q.indexOf(c));
});

test('zero votes successful match is not retried immediately; identity failures have finite backoff', () => {
  const a = complete('zero-votes'), b = record('miss'), state = {};
  const now = Date.now();
  rememberMetadata(state, a, { status: 'matched', reason: 'stored-id' }, { now });
  rememberMetadata(state, b, { status: 'unresolved', reason: 'no-title-year-match' }, { now });
  assert.equal(buildMetadataQueue([a, b], state, { now: now + 1000 }).queue.length, 0);
  assert.equal(dueForMetadata(b, state.metadata[b.id], { now: now + 7 * 3600000 }), true);
  assert.equal(buildMetadataQueue([a, b], state, { retryMisses: true }).queue.length, 1);
  assert.equal(buildMetadataQueue([a, b], state, { now: now + 31 * 86400000 }).queue.length, 2);
});

test('new records and old backlog get slots, repeated limited runs make progress', async () => {
  const old = Array.from({ length: 10 }, (_, i) => record(`old${i}`));
  const fresh = Array.from({ length: 10 }, (_, i) => record(`new${i}`, { addedAt: new Date().toISOString() }));
  const vault = [...old, ...fresh], state = {};
  const q = buildMetadataQueue(vault, state, { limit: 6 }).queue;
  assert.equal(q.filter(r => r.id.startsWith('new')).length, 3);
  assert.equal(q.filter(r => r.id.startsWith('old')).length, 3);
  const lookup = async () => ({ status: 'unresolved', reason: 'no-corroborated-match', meta: null });
  const first = await runMetadataWorker(vault, state, { ...opts, lookup, limit: 4 });
  const second = await runMetadataWorker(vault, state, { ...opts, lookup, limit: 4 });
  assert.equal(first.checked, 4); assert.equal(second.checked, 4);
  assert.ok(second.audit.every(r => !first.audit.some(a => a.id === r.id)));
});

test('six per-item failures do not abort following successful records; playback never changes', async () => {
  const vault = Array.from({ length: 7 }, (_, i) => record(`r${i}`)), state = {};
  const before = JSON.stringify(vault.map(r => [r.id, r.pageUrl, r.embeds, r.seasons, r.kind]));
  const lookup = async r => r.id === 'r6' ? { status: 'matched', reason: 'title-and-source-credits',
    meta: { tmdbId: 6, tmdbType: 'movie', originalLanguage: 'te', poster: 'new', rating: 0 } } :
    { status: 'unavailable', reason: 'source-unavailable', meta: undefined };
  const result = await runMetadataWorker(vault, state, { ...opts, lookup });
  assert.equal(result.checked, 7); assert.equal(result.unavailable, 6); assert.equal(result.matched, 1);
  assert.equal(vault[6].category, 'tamil-dubbed-movie');
  assert.equal(JSON.stringify(vault.map(r => [r.id, r.pageUrl, r.embeds, r.seasons, r.kind])), before);
  assert.equal(Object.keys(state.tmdbMiss).length, 0);
});

test('version bump/title or evidence change retries; episode additions do not reset backoff', () => {
  const r = record('x'), state = {}, now = Date.now();
  rememberMetadata(state, r, { status: 'unresolved' }, { now });
  assert.equal(dueForMetadata(r, state.metadata.x, { now }), false);
  r.embeds.push({ url: 'another' });
  assert.equal(dueForMetadata(r, state.metadata.x, { now }), false);
  assert.equal(dueForMetadata({ ...r, title: 'Corrected' }, state.metadata.x, { now }), true);
  assert.equal(dueForMetadata(r, { ...state.metadata.x, version: METADATA_VERSION - 1 }, { now }), true);
});

test('merge keeps latest attempt and cannot resurrect an older miss after success', () => {
  const a = record('x'), state = {};
  rememberMetadata(state, a, { status: 'matched', reason: 'exact' }, { now: 2000000000000 });
  const merged = mergeStates(state, { tmdbMiss: { x: '2026-01-01T00:00:00Z' }, metadata: {
    x: { status: 'unresolved', checkedAt: '2026-01-01T00:00:00Z' } } });
  assert.equal(merged.metadata.x.status, 'matched'); assert.equal(merged.tmdbMiss.x, undefined);
});

test('actual attempt count stays zero when budget disabled or no key; pending report does not mark misses', async () => {
  for (const extra of [{ budgetMin: 0 }, { hasKey: () => false }]) {
    let n = 0; const state = {};
    const out = await runMetadataWorker([record('x')], state, { ...opts, ...extra, lookup: async () => { n++; } });
    assert.equal(n, 0); assert.equal(out.checked, 0); assert.equal(out.notReached, 1); assert.equal(state.metadata, undefined);
  }
});

test('scraped credits persist in record without creating a language/category', () => {
  const v = [], sourceMetadata = { available: true, sourceTitle: 'Sample (2026)', cast: ['A', 'B'], directors: [] };
  const { record: r } = upsert(v, { title: 'Sample', year: 2026, url: 'https://example.org/sample/' },
    { kind: 'movie', embeds: [{ url: 'https://example.org/play' }], sourceMetadata });
  assert.deepEqual(r.sourceMetadata, sourceMetadata); assert.equal(r.originalLanguage, undefined); assert.equal(r.category, undefined);
});

test('CLI enriches stored backlog even after zero crawl budget, reports and saves finite retries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-cli-'));
  try {
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data/vault.json'), JSON.stringify([complete('stored', { originalLanguage: '', rating: 8 })]));
    fs.writeFileSync(path.join(dir, 'data/state.json'), JSON.stringify({ done: {} }));
    const mock = path.join(dir, 'mock.mjs');
    fs.writeFileSync(mock, `globalThis.fetch=async url=>{
      if(new URL(url).hostname==='api.themoviedb.org')return Response.json({id:10,title:'stored',release_date:'2026-01-01',original_language:'ta',vote_average:8});
      return new Response('<h1>stored (2026)</h1>');
    };`);
    const r = spawnSync(process.execPath, ['--import', mock, path.resolve('src/run.mjs'), '--mode=releases',
      '--budget-min=0', '--metadata-budget-min=1', '--no-link-check', '--no-series', '--report=reports/meta.json'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, TMDB_KEYS: 'fixture-key', TRIES: '1' }, timeout: 15000 });
    // Empty synthetic listings correctly fail the crawl, but metadata must
    // still run, save and report independently of that exhausted crawl.
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /no listing could be read/);
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'data/vault.json')));
    assert.equal(v[0].originalLanguage, 'ta');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'reports/meta.json'))).summary.checked, 1);
    assert.match(r.stdout, /own budget 1min/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every scrape workflow passes TMDB secret, has independent metadata budget, and exports diagnostics', () => {
  for (const name of ['new-releases', 'az-archive', 'isaidub']) {
    const s = fs.readFileSync(`.github/workflows/${name}.yml`, 'utf8');
    assert.match(s, /TMDB_KEYS: \$\{\{ secrets.TMDB_KEYS/);
    assert.match(s, /--metadata-budget-min=5/);
    assert.match(s, /upload-artifact@/);
  }
  assert.match(fs.readFileSync('.github/workflows/enrich.yml', 'utf8'), /schedule:\n\s+- cron:/);
});
