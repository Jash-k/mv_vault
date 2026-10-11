import fs from 'node:fs';
import path from 'node:path';
import * as V from './vault.mjs';
import * as T from './tmdb.mjs';
import { enrichRecordDetailed } from './metadata-evidence.mjs';
import { currentAttempt, dueForMetadata, rememberMetadata } from './metadata-state.mjs';

export function loadMetadataOverrides(file = 'metadata-overrides.json') {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('expected an object keyed by vault record ID');
    for (const [id, o] of Object.entries(data)) {
      if (!o || !Number.isInteger(o.tmdbId) || o.tmdbId < 1 || !['movie', 'tv'].includes(o.tmdbType) ||
        !o.expectedTitle || !o.reason || !o.evidenceUrls?.length ||
        !o.evidenceUrls.every(u => { try { return new URL(u).protocol === 'https:'; } catch { return false; } })) {
        throw new Error(`invalid reviewed mapping for ${id}`);
      }
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

const requiresIdentity = m => V.needsMetadata(m) || m.categorySource === 'site';
const hasWork = m => requiresIdentity(m) || V.missingOptionalMetadata(m);
const changedEvidence = (m, entry, override) => Boolean(entry && !currentAttempt(m, entry, override));

/** Durable queue = eligible vault rows + persisted attempt state. Never a
 * touched-only queue, so a stored/skipped movie cannot fall through the cracks.
 * Weighted lanes prevent both old backlog and newest releases from starving.
 */
export function buildMetadataQueue(vault, state, { now = Date.now(), limit = 0, only = '',
  retryMisses = false, staleDays = 0, verifyIds = false, priorityIds = new Set(), overrides = {} } = {}) {
  const need = vault.filter(m => m.embeds?.length && (!only || `${m.id} ${m.title} ${m.pageUrl}`.toLowerCase().includes(only.toLowerCase())) &&
    (verifyIds || hasWork(m) || changedEvidence(m, state.metadata?.[m.id], overrides[m.id]) || (overrides[m.id] && !currentAttempt(m, state.metadata?.[m.id], overrides[m.id]))));
  const eligible = need.filter(m => dueForMetadata(m, state.metadata?.[m.id], { now, staleDays,
    force: verifyIds || (retryMisses && (requiresIdentity(m) || state.metadata?.[m.id]?.status !== 'matched')),
    override: overrides[m.id] }));
  const lanes = [[], [], []]; // new identity, durable backlog, optional artwork
  for (const m of eligible) {
    const prior = state.metadata?.[m.id];
    const neverTried = !currentAttempt(m, prior, overrides[m.id]);
    const recent = now - (Date.parse(m.addedAt || '') || 0) < 7 * 86400_000;
    const important = requiresIdentity(m) || verifyIds || Boolean(overrides[m.id]) || changedEvidence(m, prior, overrides[m.id]);
    const lane = !important ? 2 : neverTried && (recent || priorityIds.has(m.id)) ? 0 : 1;
    lanes[lane].push(m);
  }
  const lastAttempt = m => currentAttempt(m, state.metadata?.[m.id], overrides[m.id]) ?
    Date.parse(state.metadata[m.id].checkedAt || '') || 0 : 0;
  lanes[0].sort((a, b) => (Date.parse(b.addedAt || '') || 0) - (Date.parse(a.addedAt || '') || 0) || a.id.localeCompare(b.id));
  for (const lane of lanes.slice(1)) lane.sort((a, b) => lastAttempt(a) - lastAttempt(b) || a.id.localeCompare(b.id));
  const queue = [];
  // When there's backlog, three newest slots, three backlog slots, one optional
  // slot; empty lanes cost nothing. The bounded run persists only real attempts.
  const pattern = [0, 0, 0, 1, 1, 1, 2];
  const positions = [0, 0, 0];
  while (queue.length < eligible.length && (!limit || queue.length < limit)) {
    for (const lane of pattern) {
      if (positions[lane] < lanes[lane].length) queue.push(lanes[lane][positions[lane]++]);
      if (limit && queue.length >= limit) break;
    }
  }
  return { queue, needs: need.length, eligible: eligible.length, deferred: need.length - eligible.length,
    identity: need.filter(requiresIdentity).length };
}

function reportRows(vault, state, overrides, attempts) {
  const attempted = new Set(attempts.map(a => a.id));
  return [...attempts, ...vault.filter(m => requiresIdentity(m) && !attempted.has(m.id)).map(m => {
    const entry = state.metadata?.[m.id];
    const current = currentAttempt(m, entry, overrides[m.id]);
    return { id: m.id, title: m.title, year: m.year, status: current ? entry.status : 'pending',
      reason: current ? entry.reason : 'not-attempted-this-version',
      ...(current ? { checkedAt: entry.checkedAt, nextRetryAt: entry.nextRetryAt } : {}) };
  })];
}

/** A fresh bounded budget belongs ONLY to metadata, not the preceding crawl. */
export async function runMetadataWorker(vault, state, options = {}) {
  const { budgetMin = 5, limit = 150, concurrency = 4, verifyIds = false, dry = false,
    reportPath = '', log = () => {}, save = () => {}, lookup = enrichRecordDetailed,
    hasKey = T.hasKey, keysDown = T.allKeysDown, overrides = loadMetadataOverrides() } = options;
  const selection = buildMetadataQueue(vault, state, { ...options, limit, overrides });
  const result = { checked: 0, filled: 0, posters: 0, categories: 0, siteCategories: 0,
    misses: 0, unavailable: 0, review: 0, matched: 0, selected: selection.queue.length,
    eligible: selection.eligible, deferred: selection.deferred, notReached: selection.queue.length,
    needsKey: !hasKey(), skipped: !hasKey(), reasons: {}, stopReason: '', audit: [] };
  log(`metadata identity/classification needed: ${selection.identity} · eligible now: ${selection.eligible} · this run: ${selection.queue.length} · retry later: ${selection.deferred}`);
  const writeReport = () => {
    if (!reportPath || dry) return;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const { audit, ...summary } = result;
    V.writeJson(reportPath, { generatedAt: new Date().toISOString(), summary,
      records: reportRows(vault, state, overrides, audit) });
  };
  if (!hasKey() || budgetMin <= 0 || limit < 0) {
    result.stopReason = !hasKey() ? 'tmdb-nokey' : 'metadata-disabled';
    log(!hasKey() ? '! TMDB_KEYS / TMDB_API_KEY not passed to this job — metadata stays pending' : 'metadata disabled');
    writeReport();
    return result;
  }
  const deadline = Date.now() + budgetMin * 60000;
  const parallel = Math.max(1, Math.min(Number(concurrency) || 4, 8));
  log(`metadata own budget ${budgetMin}min · ${parallel} parallel lookups · newest + backlog + optional lanes`);
  let checkpoint = Date.now();
  for (let i = 0; i < selection.queue.length; i += parallel) {
    if (Date.now() >= deadline) { result.stopReason = 'budget'; break; }
    if (keysDown()) { result.stopReason = 'tmdb-keys-unavailable'; break; }
    const batch = selection.queue.slice(i, i + parallel);
    const outcomes = await Promise.all(batch.map(async record => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { record, notStarted: true };
      const conflict = Boolean(record.tmdbId && V.needsCategory(record));
      const recheck = changedEvidence(record, state.metadata?.[record.id], overrides[record.id]);
      const candidate = { ...record, kind: record.kind === 'series' ? 'series' : 'movie',
        verifyIds: verifyIds || conflict || recheck, ...(overrides[record.id] ? { metadataOverride: overrides[record.id] } : {}) };
      // Stale known language must not prevent correction of a suspect stored ID.
      if (candidate.verifyIds) delete candidate.originalLanguage;
      let outcome;
      try { outcome = await lookup(candidate, { timeoutMs: Math.min(45000, remaining), maxRequests: 120 }); }
      catch { outcome = { status: 'unavailable', reason: 'lookup-error', meta: undefined }; }
      return { record, outcome, conflict: conflict || recheck };
    }));
    for (const { record, outcome, conflict, notStarted } of outcomes) {
      if (notStarted) continue;
      result.checked += 1;
      const wasPoster = Boolean(record.poster), wasCategory = record.category;
      if (outcome.meta) {
        const changed = V.applyMetadata(record, outcome.meta, {
          preferPoster: true, replaceId: verifyIds || conflict || Boolean(overrides[record.id]),
        });
        if (changed) result.filled += 1;
        if (!wasPoster && record.poster) result.posters += 1;
        if (wasCategory !== record.category) result.categories += 1;
        if (V.needsMetadata(record)) {
          outcome.status = 'unresolved'; outcome.reason = 'original-language-missing';
        }
      }
      if (outcome.status === 'matched') result.matched += 1;
      else if (outcome.status === 'unavailable') result.unavailable += 1;
      else if (outcome.status === 'review') result.review += 1;
      else result.misses += 1;
      const entry = rememberMetadata(state, record, outcome, { override: overrides[record.id] });
      result.reasons[entry.reason] = (result.reasons[entry.reason] || 0) + 1;
      result.audit.push({ id: record.id, title: record.title, year: record.year, ...entry,
        ...(outcome.meta ? { tmdbId: outcome.meta.tmdbId, tmdbType: outcome.meta.tmdbType,
          tmdbTitle: outcome.meta.tmdbTitle, originalYear: outcome.meta.originalYear,
          originalLanguage: outcome.meta.originalLanguage, match: outcome.meta.match,
          ...(outcome.meta.evidence ? { evidence: outcome.meta.evidence } : {}) } : {}) });
      log(`  ${entry.status === 'matched' ? '★' : '·'} ${record.title} (${record.year || '?'}) — ${entry.status}: ${entry.reason}${entry.status === 'matched' ? ` · ${record.originalLanguage} · ${record.category}` : ` · retry ${entry.nextRetryAt}`}`);
    }
    result.notReached = selection.queue.length - result.checked;
    // Successful or unavailable attempts all move the queue forward. No global
    // 'five incomplete titles' stop; only a real key-wide outage stops the run.
    if (result.checked % 20 < parallel || Date.now() - checkpoint >= 15000) {
      if (!dry) await save();
      writeReport();
      checkpoint = Date.now();
    }
  }
  result.notReached = selection.queue.length - result.checked;
  if (!result.stopReason) result.stopReason = result.notReached ? 'budget' : 'queue-complete';
  if (!dry) await save();
  writeReport();
  log(`metadata ${result.checked} actually attempted · ${result.matched} matched · ${result.filled} changed · ${result.misses} unresolved · ${result.review} review · ${result.unavailable} unavailable · ${result.notReached} not reached`);
  return result;
}
