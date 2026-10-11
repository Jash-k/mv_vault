import { createHash } from 'node:crypto';

// Bump only for matching/eligibility changes. Legacy tmdbMiss entries are never
// permanent exclusions; a new matching version gets one fresh attempt.
export const METADATA_VERSION = 2;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function metadataFingerprint(record, override) {
  const source = record.sourceMetadata || {};
  return createHash('sha256').update(JSON.stringify([
    record.title, record.year, record.kind || 'movie', record.tmdbType || '',
    record.tmdbId || 0, record.originalLanguage || '', record.category || '',
    source.sourceTitle || '', source.sourceYear || 0, source.cast || [], source.directors || [],
    override || null,
  ])).digest('hex').slice(0, 20);
}

export const currentAttempt = (record, entry, override) => Boolean(entry &&
  entry.version === METADATA_VERSION && entry.identity === metadataFingerprint(record, override));

export function dueForMetadata(record, entry, { now = Date.now(), force = false, staleDays = 0, override } = {}) {
  if (force || !currentAttempt(record, entry, override)) return true;
  const checked = Date.parse(entry.checkedAt || '') || 0;
  if (staleDays > 0 && now - checked >= staleDays * DAY) return true;
  return now >= (Date.parse(entry.nextRetryAt || '') || 0);
}

export function rememberMetadata(state, record, outcome, { now = Date.now(), override } = {}) {
  const previous = state.metadata?.[record.id];
  const attempts = currentAttempt(record, previous, override) ? (previous.attempts || 0) + 1 : 1;
  const status = outcome.status;
  // Missing artwork, IMDb IDs and zero votes are valid upstream values. Do not
  // put a successfully classified record at the front of every subsequent run.
  const delays = status === 'matched' ? [30 * DAY]
    : status === 'unavailable' ? [HOUR, 6 * HOUR, DAY]
    : status === 'review' ? [7 * DAY, 30 * DAY]
    : [6 * HOUR, DAY, 3 * DAY, 7 * DAY];
  const delay = delays[Math.min(attempts - 1, delays.length - 1)];
  const entry = { version: METADATA_VERSION, identity: metadataFingerprint(record, override),
    status, reason: outcome.reason || status, attempts,
    checkedAt: new Date(now).toISOString(), nextRetryAt: new Date(now + delay).toISOString(),
    requests: outcome.requests || 0,
    ...(outcome.notes?.length ? { notes: outcome.notes.slice(-12) } : {}) };
  state.metadata ||= {};
  state.metadata[record.id] = entry;
  // Keep the old field compatible, but it is no longer consulted for scheduling.
  state.tmdbMiss ||= {};
  if (status === 'unresolved' || status === 'review') state.tmdbMiss[record.id] = entry.checkedAt;
  else delete state.tmdbMiss[record.id];
  return entry;
}

export function mergeMetadataStates(ours = {}, theirs = {}) {
  const result = { ...theirs };
  for (const [id, value] of Object.entries(ours || {})) {
    const other = result[id];
    if (!other || String(value.checkedAt || '') > String(other.checkedAt || '') ||
      (value.checkedAt === other.checkedAt && value.status === 'matched')) result[id] = value;
  }
  return result;
}
