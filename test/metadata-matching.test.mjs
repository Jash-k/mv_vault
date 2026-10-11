import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TMDB_KEYS = 'fixture-key'; process.env.TRIES = '1';
const { enrichRecordDetailed, sourceEvidence } = await import('../src/metadata-evidence.mjs');
const { creditEvidence, titleSimilarity } = await import('../src/tmdb.mjs');
const credits = { cast: [{ id: 10, name: 'Actor One' }, { id: 11, name: 'Actor Two' }], crew: [] };
const evidence = { available: true, sourceUrl: 'https://moviezda.net/sample/', sourceTitle: 'Sample',
  sourceYear: 2026, fetchedAt: new Date().toISOString(), cast: ['Actor One', 'Actor Two'], directors: [] };
function mock(details, { truncated = false, noCast = false, distinctive = true } = {}) {
  const calls = [];
  globalThis.fetch = async url => {
    const u = new URL(url); calls.push(u);
    if (u.hostname !== 'api.themoviedb.org') return new Response('<h1>Sample (2026)</h1>');
    if (u.pathname.includes('/search/person')) return Response.json({ results: truncated && distinctive ? [{id:u.searchParams.get('query')==='Actor Two'?11:10,name:u.searchParams.get('query')}] : [], total_pages: 1 });
    if (u.pathname.includes('/person/')) return Response.json({cast:details});
    if (u.pathname.includes('/search/')) {
      if (truncated && !u.searchParams.has('year')) return Response.json({ results: [], total_pages: 20 });
      return Response.json({ results: details, total_pages: 1 });
    }
    const d = details.find(x => x.id === Number(u.pathname.split('/').at(-1)));
    if (!d) return new Response('', { status: 404 });
    return Response.json({ ...d, credits: noCast ? {} : credits, aggregate_credits: noCast ? {} : credits });
  };
  return calls;
}
function rec(title, extra = {}) {
  return { title, year: 2026, pageUrl: 'https://moviesda34.com/sample/', sourceMetadata: evidence, ...extra };
}

test('short TV title truncation scopes by episode-air year and requires independent credits', async () => {
  const d = { id: 1, name: 'Eyes', first_air_date: '2026-01-01', original_language: 'ml' };
  const calls = mock([d], { truncated: true });
  const out = await enrichRecordDetailed(rec('Eyes', { kind: 'series' }));
  assert.equal(out.status, 'review'); assert.equal(out.meta, null);
  assert.equal(out.notes.find(n => n.reason === 'scoped-match-needs-review').suggestedOriginalLanguage, 'ml');
  assert.ok(calls.some(u => u.pathname.includes('/search/tv') && u.searchParams.get('year') === '2026'));
  assert.ok(calls.every(u => !u.searchParams.has('first_air_date_year')));
  mock([d], { truncated: true, noCast: true });
  const notSafe = await enrichRecordDetailed(rec('Eyes', { kind: 'series' }));
  assert.equal(notSafe.status, 'unavailable'); assert.equal(notSafe.meta, undefined);
});

test('TV wrong source credits are held for review, not assigned a movie identity', async () => {
  mock([{ id: 1, name: 'Fall', first_air_date: '2022-01-01', original_language: 'ta' }]);
  const out = await enrichRecordDetailed(rec('Fall Season 1', { kind: 'series', year: 2022,
    sourceMetadata: { ...evidence, sourceYear: 2022, cast: ['Film Actor', 'Other Film Actor'] } }));
  assert.equal(out.meta, null); assert.equal(out.status, 'review'); assert.equal(out.reason, 'source-credits-conflict');
});

test('TV later dubbed-year match requires exact title plus source cast, not a year guess', async () => {
  mock([{ id: 1, name: 'Hush Hush', first_air_date: '2022-01-01', original_language: 'hi' }]);
  const out = await enrichRecordDetailed(rec('Hush Hush Season 01', { kind: 'series', year: 2023,
    sourceMetadata: { ...evidence, sourceYear: 2023 } }));
  assert.equal(out.meta?.tmdbType, 'tv'); assert.equal(out.reason, 'title-and-source-credits');
  mock([{ id: 1, name: 'Hush Hush', first_air_date: '2022-01-01', original_language: 'hi' }], { noCast: true });
  const no = await enrichRecordDetailed(rec('Hush Hush Season 01', { kind: 'series', year: 2023 }));
  assert.equal(no.meta, null);
});

test('TV official subtitle can match with two credits, but not a competing franchise', async () => {
  const d = { id: 1, name: 'Scam 2003: The Telgi Story', first_air_date: '2023-01-01', original_language: 'hi' };
  mock([d]);
  const out = await enrichRecordDetailed(rec('Scam 2003', { kind: 'series', year: 2023, sourceMetadata: { ...evidence, sourceYear: 2023 } }));
  assert.equal(out.meta?.tmdbId, 1); assert.equal(out.reason, 'subtitle-and-source-credits');
  mock([d, { ...d, id: 2, name: 'Scam 2003: Another Story' }]);
  const no = await enrichRecordDetailed(rec('Scam 2003', { kind: 'series', year: 2023 }));
  assert.equal(no.meta, null);
});

test('equivalent written numerals can corroborate; sequels and duplicate credit names do not', () => {
  assert.equal(titleSimilarity('Winners and Sinners', 'Winners & Sinners'), 1);
  assert.equal(titleSimilarity('Movie Chapter II', 'Movie Chapter Two'), 1);
  assert.equal(titleSimilarity('Movie Chapter II', 'Movie Chapter III'), 0);
  const d = { credits: { cast: [{ id: 1, name: 'Sammo Hung', original_name: 'Sammo Kam-Bo Hung' }],
    crew: [{ id: 1, name: 'Sammo Hung', job: 'Director' }] } };
  assert.equal(creditEvidence(d, { cast: ['Sammo Hung', 'Sammo Kam-Bo Hung'] }).strong, false);
  assert.equal(creditEvidence(d, { cast: ['Sammo Hung'], directors: ['Sammo Hung'] }).strong, false);
});

test('cached source evidence prevents duplicate read and never invents original language', async () => {
  let called = 0; globalThis.fetch = async () => { called++; throw Error('unexpected'); };
  const out = await sourceEvidence(rec('Sample'));
  assert.equal(called, 0); assert.deepEqual(out, evidence); assert.equal(out.originalLanguage, undefined);
});

test('context has per-record diagnostics and hard request budget without keys in errors', async () => {
  mock([{ id: 1, title: 'Sample', release_date: '2026-01-01', original_language: 'ta' }]);
  const out = await enrichRecordDetailed(rec('Sample'), { maxRequests: 1 });
  assert.equal(out.status, 'unavailable'); assert.equal(out.requests, 1);
  assert.ok(out.notes.some(x => x.reason === 'tmdb-request-budget'));
  assert.ok(!JSON.stringify(out).includes('fixture-key'));
});

test('reviewed override validates both ID and expected canonical title; bad mapping stays review', async () => {
  mock([{ id: 1, name: 'Fall', first_air_date: '2022-01-01', original_language: 'ta' }]);
  const mapping = { tmdbId: 1, tmdbType: 'tv', expectedTitle: 'Fall', reason: 'manually corroborated', evidenceUrls: ['https://example.org/official'] };
  const out = await enrichRecordDetailed(rec('Fall Season 1', { kind: 'series', metadataOverride: mapping }));
  assert.equal(out.status, 'matched'); assert.equal(out.reason, 'reviewed-override');
  const wrong = await enrichRecordDetailed(rec('Fall', { kind: 'series', metadataOverride: { ...mapping, expectedTitle: 'Unrelated' } }));
  assert.equal(wrong.status, 'review'); assert.equal(wrong.reason, 'override-conflict');
});

test('scoped long-running same title cannot use an arbitrary season year, and common names are insufficient', async () => {
  const d = { id: 1, name: 'Eyes', first_air_date: '2005-01-01', seasons: [{season_number:9,air_date:'2026-01-01'}], original_language: 'en' };
  mock([d], { truncated: true });
  const unnumbered = await enrichRecordDetailed(rec('Eyes', {kind:'series',seasons:[{season:9}]}));
  assert.equal(unnumbered.status, 'unavailable');
  mock([d], { truncated: true });
  const numbered = await enrichRecordDetailed(rec('Eyes Season 9', {kind:'series',seasons:[{season:9}]}));
  assert.equal(numbered.status, 'review');
  assert.equal(numbered.notes.find(n => n.reason === 'scoped-match-needs-review').evidence.distinctive[0].personId, 10);
  mock([{...d,first_air_date:'2026-01-01'}], {truncated:true,distinctive:false});
  const common = await enrichRecordDetailed(rec('Eyes', {kind:'series'}));
  assert.equal(common.status, 'unavailable');
});

test('aggregate TV credits are requested, not latest-season-only credits', async () => {
  const calls = mock([{id:1,name:'Sample',first_air_date:'2026-01-01',original_language:'ta'}]);
  await enrichRecordDetailed(rec('Sample', {kind:'series'}));
  assert.ok(calls.some(u => (u.searchParams.get('append_to_response') || '').includes('aggregate_credits')));
});
