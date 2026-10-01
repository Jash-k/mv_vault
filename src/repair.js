#!/usr/bin/env node
/**
 * src/repair.js — one-off repairs for data that was written by an older/buggy run.
 *
 *   node src/repair.js                     # DRY RUN: report what it would fix
 *   node src/repair.js --apply             # do it
 *   node src/repair.js --apply --only=junk,merge,dead
 *   node src/repair.js --apply --ids=sardar-2-2026,bigg-boss-season-10   # limit the liveness sweep
 *   node src/repair.js --live-ids=101716,101717                           # check specific embed ids
 *
 * Three classes of damage, all observed in this vault:
 *
 *   junk    A record titled from a button label ("Download Now") instead of its
 *           page. The title/year are re-derived from the pageUrl; if that yields a
 *           different slug the record is renamed (and merged if the target id
 *           already exists). Deep links to the old id retire — they pointed at a
 *           record nobody could find by name anyway.
 *
 *   merge   A web series re-listed on a new page (the old URL became a nav-only
 *           stub). Every config/page-aliases.json entry is walked and unioned into
 *           its target record, so episodes the site has since removed from the
 *           page are kept and the new ones are added.
 *
 *   dead    Embed links that now serve an empty player. Confirmed-dead links are
 *           pruned from the flat list AND the seasons tree; the record is re-walked
 *           first to pick up replacements. A record is never left with zero
 *           embeds — if there is nothing live to replace them with, it is left
 *           intact and queued for a retry instead.
 *
 * Everything is atomic (via store.saveAll) and idempotent: running it twice
 * changes nothing the second time.
 */
import { createWalk, walkItem } from './walk.js';
import { refreshRecord, pruneDeadEmbeds, runMaintenance } from './refresh.js';
import { sweepEmbeds } from './liveness.js';
import { planJunkRepairs } from './repair-plan.js';
import {
  loadData, saveAll, upsertRecord, recordFromWalk, loadLiveness, saveLiveness, planLiveness,
} from './store.js';
import { titleForEntry, isGenericLabel } from './titles.js';
import { loadPageAliases } from './delta.js';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const APPLY = has('apply');
const ONLY = String(arg('only', 'junk,merge,dead')).split(',').map((s) => s.trim()).filter(Boolean);
const ids = String(arg('ids', '')).split(',').map((s) => s.trim()).filter(Boolean);
const liveIds = String(arg('live-ids', '')).split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(arg('limit', 0)) || 0;
const PAGE_ALIASES = loadPageAliases();

const { state, vault } = loadData();
const liveness = loadLiveness();
const walk = createWalk({ concurrency: Number(arg('concurrency', 6)) || 6 });
const summary = { junk: 0, merged: 0, deadChecked: 0, deadPruned: 0, refreshed: 0, stuck: 0 };

const headings = (text) => console.log(`\n${text}\n${'─'.repeat(text.length)}`);

async function repairJunkTitles() {
  headings('1. Records titled from a button label');
  const rows = planJunkRepairs(vault); // src/repair-plan.js — the rules live there
  if (!rows.length) return console.log('  none.');
  let changed = 0;
  for (const { record, path, title, year, id, same, clash } of rows) {
    console.log(`  ${APPLY && !same ? '*' : '='} ${record.id.padEnd(26)} → ${id.padEnd(26)} "${record.title}" (${record.year || '—'}) → "${title}" (${year || '—'})`);
    if (same) continue;
    changed += 1;
    summary.junk += 1;
    if (!APPLY) continue;

    if (clash) {
      // the corrected id already exists: fold into it instead of renaming
      upsertRecord(vault, { ...record, id, title, year });
      vault.splice(vault.indexOf(record), 1);
      console.log(`      merged into the existing ${id}`);
    } else {
      record.id = id;
      record.title = title;
      record.year = year;
      record.updatedAt = new Date().toISOString();
    }
  }
  console.log(`  → ${changed} record(s) ${APPLY ? 'repaired' : 'would be repaired'}`);
}

async function repairMergedPages() {
  headings('2. Pages that describe an existing record (config/page-aliases.json)');
  const entries = Object.entries(PAGE_ALIASES.mergeInto || {});
  if (!entries.length) return console.log('  no aliases configured.');
  for (const [path, targetId] of entries) {
    const record = vault.find((r) => r.id === targetId);
    const url = `https://moviesda34.com${path}`;
    if (!record) {
      console.log(`  ! ${path} → ${targetId} (no such record — skipped)`);
      continue;
    }
    const beforeEps = (record.seasons || []).reduce((n, s) => n + s.episodes.length, 0);
    const beforeEmbeds = record.embeds.length;
    if (!APPLY) {
      console.log(`  ? ${path} → ${record.id} (currently ${beforeEmbeds} embeds${beforeEps ? `, ${beforeEps} episodes` : ''}) would be walked and unioned`);
      continue;
    }
    let walked;
    try {
      walked = await walkItem(url, { walk });
    } catch (error) {
      console.log(`  ! ${path} → ${record.id}: ${error.message}`);
      continue;
    }
    const fresh = recordFromWalk(
      { url, path, title: record.title, year: record.year, kind: record.kind === 'series' ? 'series' : 'movie', id: record.id, locked: true },
      walked,
      { id: record.id },
    );
    if (!fresh) {
      console.log(`  = ${path} → ${record.id}: page read, no live embeds (nothing to add)`);
      continue;
    }
    const { action, twin } = upsertRecord(vault, fresh);
    const after = vault.find((r) => r.id === (twin || record.id));
    const afterEps = (after.seasons || []).reduce((n, s) => n + s.episodes.length, 0);
    console.log(`  ${action === 'unchanged' ? '=' : '*'} ${path} → ${after.id}: embeds ${beforeEmbeds} → ${after.embeds.length}${afterEps ? `, episodes ${beforeEps} → ${afterEps}` : ''}`);
    summary.merged += 1;
  }
}

async function repairDeadLinks() {
  headings('3. Embed links that no longer play');

  // a quick, explicit check of ids named on the command line
  if (liveIds.length) {
    const urls = liveIds.map((id) => `https://play.onestream.today/stream/page/${id}`);
    const sweep = await sweepEmbeds(urls);
    for (const r of sweep.results) console.log(`  ${r.state.padEnd(8)} ${r.url.split('/').pop()}  ${r.reason || `${r.bytes} bytes`}`);
  }

  if (!ONLY.includes('dead')) return;
  const scope = ids.length ? vault.filter((r) => ids.includes(r.id)) : vault;
  const limit = LIMIT || scope.length;
  if (!APPLY) {
    const { neverChecked } = planLiveness(vault, liveness, {});
    console.log(`  ${scope.length} record(s) in scope; ${limit} would be liveness-checked this pass.`);
    console.log(`  ${vault.filter((r) => !liveness[r.id]?.at).length} have never been checked (${neverChecked} eligible).`);
    console.log('  re-run with --apply to sweep them (one request per embed).');
    return;
  }
  const result = await runMaintenance({
    vault, walk, liveness, pageAliases: PAGE_ALIASES, limit, refreshLimit: 0,
    onlyIds: ids.length ? ids : null,
    onProgress: (record, r) => console.log(`      ⟳ ${record.id}: ${r.walked ? 'refreshed' : 'could not re-walk'}`),
  });
  saveLiveness(liveness);
  summary.deadChecked = result.checked;
  summary.deadPruned = result.pruned;
  summary.refreshed = result.refreshed;
  summary.stuck = result.stuck.length;
  console.log(`  checked ${result.checked} embed(s) across ${result.records} record(s): ${result.live} live, ${result.dead} dead, ${result.unknown} unknown`);
  console.log(`  refreshed ${result.refreshed} record(s), pruned ${result.pruned} dead link(s)`);
  for (const stuck of result.stuck.slice(0, 10)) console.log(`  ! ${stuck.id}: ${stuck.reason}`);
}

if (ONLY.includes('junk')) await repairJunkTitles();
if (ONLY.includes('merge')) await repairMergedPages();
if (ONLY.includes('dead') || liveIds.length) await repairDeadLinks();

if (APPLY) {
  saveAll({ state, vault });
  summary.junk + summary.merged + summary.deadPruned > 0
    ? console.log(`\n[repair] applied — vault.json rewritten (${vault.length} records). Verify with: node src/verify.js`)
    : console.log('\n[repair] applied — nothing needed changing.');
} else {
  console.log('\n[repair] DRY RUN — nothing written. Add --apply to make these changes.');
}
