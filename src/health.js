/**
 * src/health.js — should this run's verdicts be believed?
 *
 * The vault's worst failure mode is not a crash; it is a run that *looks*
 * successful. If the site changes shape (or blocks us), every walk returns no
 * embeds, and an unwary scrape writes "empty" for hundreds of items — which is
 * not just wrong today, it pushes each of those items 12h/1d/3d/7d/30d into the
 * future, so the catalogue stays broken for a month after the site recovers.
 *
 * So: results are collected, the run judges itself, and only then are the
 * verdicts written. Pure functions, so the policy is testable and readable.
 */
export const EMPTY_RATIO_LIMIT = 0.85;   // 85% of walked items empty → not a catalogue, a shape change
export const FAIL_RATIO_LIMIT = 0.3;     // 30% unreadable → the host is refusing us
export const MIN_ITEMS_FOR_RATIO = 8;    // below this, percentages say nothing
export const UNREADABLE_URL_LIMIT = 40;  // absolute backstop

/** Judge the walk part of a run (as opposed to discovery). */
export function assessWalk(counts = {}, { unreadableUrls = 0 } = {}) {
  const walked = (counts.added || 0) + (counts.merged || 0) + (counts.unchanged || 0)
    + (counts.empty || 0) + (counts.failed || 0);
  const problems = [];
  if (walked >= MIN_ITEMS_FOR_RATIO) {
    const emptyRatio = (counts.empty || 0) / walked;
    const failRatio = (counts.failed || 0) / walked;
    if (emptyRatio > EMPTY_RATIO_LIMIT) {
      problems.push(`${Math.round(emptyRatio * 100)}% of ${walked} walked items came back empty — likely a site/walker shape change`);
    }
    if (failRatio > FAIL_RATIO_LIMIT) {
      problems.push(`${Math.round(failRatio * 100)}% of walked items were unreadable`);
    }
  }
  if (unreadableUrls >= UNREADABLE_URL_LIMIT) problems.push(`${unreadableUrls} distinct URLs were unreadable this run`);
  return { degraded: problems.length > 0, problems, walked, emptyRatio: walked ? (counts.empty || 0) / walked : 0 };
}

/** Combine discovery health (src/delta.js) with walk health. */
export function combineHealth(discovery = { degraded: false, problems: [] }, walk = { degraded: false, problems: [] }) {
  return {
    degraded: Boolean(discovery.degraded || walk.degraded),
    problems: [...(discovery.problems || []), ...(walk.problems || [])],
    discovery,
    walk,
  };
}

/**
 * The decision that matters: an item came back with no embeds. Is that a fact
 * about the item ("not live yet") or about us ("could not look properly")?
 *
 *   'failed' → re-try in 90 minutes, ladder untouched
 *   'empty'  → the 12h/1d/3d/7d/30d ladder advances
 */
export function decideNoEmbeds(health = { degraded: false, problems: [] }) {
  if (health.degraded) return { verdict: 'failed', reason: health.problems.join('; ') || 'run degraded' };
  return { verdict: 'empty', reason: '' };
}
