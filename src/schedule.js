/**
 * src/schedule.js — WHEN a tracked item is worth looking at again.
 *
 * One place, because two modules need the same answer: `store.js` writes the
 * decision (markEmpty / markFailed / markPartial) and `delta.js` reads it.
 *
 * The v2.1 change: **a network failure is not an empty page.**
 *
 *   empty   — the page is live and genuinely has no embed yet. Re-check on the
 *             widening ladder: 12h, 1d, 3d, 7d, 30d. This is the new-release
 *             case the detector exists for.
 *   failed  — we could not read the page (5xx, timeout, connection reset).
 *             Nothing was learned, so the ladder MUST NOT advance. Re-check in
 *             90 minutes instead — usually the same day, on the catch-up run.
 *             After MAX_FAILURES consecutive failures the item is marked `dead`
 *             (a genuinely deleted page) so it stops costing requests forever.
 *   partial — the walk succeeded but some hops failed (a folder page 502'd, an
 *             embed confirm timed out). The item IS stored, so it already has
 *             embeds; a 24h re-walk unions in whatever was missed. This is what
 *             stops one flaky request from turning a 16-embed film into a
 *             6-embed one and never looking again.
 *
 * All timestamps are absolute ISO strings (`retryAfter`) so "due" is a single
 * comparison instead of a computation that drifts every time a run is late.
 */
export const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Hours to wait before the next look at a genuinely empty page. */
export const RETRY_HOURS = [12, 24, 72, 168, 720];

/** Kept for the pre-2.1 day ladder (entries written by older runs). */
export const RETRY_DAYS = [1, 3, 7, 30];

/** A failed read is re-tried quickly — it is usually transient. */
export const FAILURE_BACKOFF_MIN = 90;

/** Consecutive read failures after which a page is treated as deleted. */
export const MAX_FAILURES = 5;

/** A partially-walked item is re-walked once the flakiness has passed. */
export const PARTIAL_RECHECK_HOURS = 24;
export const MAX_PARTIAL_RECHECKS = 2;

/** ISO timestamp of the next look, given how many empty-runs have happened. */
export function nextRetryAt(retries, now = Date.now()) {
  const index = Math.max(0, Math.min(Number(retries) || 0, RETRY_HOURS.length - 1));
  return new Date(now + RETRY_HOURS[index] * HOUR_MS).toISOString();
}

/** ISO timestamp of the next look after a transient read failure. */
export function nextFailureAt(now = Date.now()) {
  return new Date(now + FAILURE_BACKOFF_MIN * 60_000).toISOString();
}

/**
 * Is a tracked entry worth attempting again?
 * Returns { due, attempt, dead }.
 */
export function retryStatus(entry, now = Date.now()) {
  if (!entry || !entry.empty) return { due: false, attempt: 0 };
  const attempt = Number(entry.retries || 0);
  // Legacy dead pages are probationary, not permanently excluded.
  if (entry.dead) return { due: now >= (Date.parse(entry.at || '') || 0) + 7 * DAY_MS, attempt, dead: false };

  // Explicit decision (v2.1+): one comparison, no drift.
  if (entry.retryAfter) {
    const at = Date.parse(entry.retryAfter) || 0;
    // The final 30-day rung repeats; pages may become available much later.
    return { due: now >= at, attempt, at };
  }

  // Legacy entries: no retryAfter, maybe no counter at all.
  // The final 30-day rung repeats; pages may become available much later.
  const last = Date.parse(entry.at || '') || 0;
  if (!last) return { due: true, attempt }; // unknown age → try it
  // Legacy entries (written before v2.0) have no counter at all: give them the
  // documented 1-day first look, not one hour.
  const waitMs = (entry.retries === undefined ? 24 : RETRY_HOURS[Math.min(attempt, RETRY_HOURS.length - 1)]) * HOUR_MS;
  return { due: now - last >= waitMs, attempt };
}

/** Is a partially-walked item worth a second pass? (24h later, at most twice.) */
export function partialStatus(entry, now = Date.now()) {
  if (!entry || !entry.partial) return { due: false, rechecks: 0 };
  const rechecks = Number(entry.rechecks || 0);
  // Keep partial work recoverable; use a slower cadence after repeated attempts.
  const last = Date.parse(entry.at || '') || 0;
  return { due: !last || now - last >= Math.min(168, PARTIAL_RECHECK_HOURS * Math.max(1, rechecks)) * HOUR_MS, rechecks };
}

/** Human-readable ladder, for logs and the README. */
export const ladderLabel = () => RETRY_HOURS.map((h) => (h < 24 ? `${h}h` : `${h / 24}d`)).join(' → ');

export const _internal = { DAY_MS };
