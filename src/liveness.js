/**
 * src/liveness.js — "is this embed still there?"
 *
 * Why this exists: the vault's premise is that onestream links are durable, but
 * the site RE-UPLOADS titles — Sardar 2's three links were replaced with four
 * new ids within days, and the old three served an empty page. Nothing in v2.0
 * ever checked, so the vault happily handed the app dead players forever.
 *
 * Measured shape of the two states (2026-10-01):
 *   live → HTTP 200, ~12 KB document containing <source src="…fastbytes…">
 *   dead → HTTP 200, 0 bytes (the player is simply gone)
 *
 * The safety rule that matters most: a network error is UNKNOWN, never DEAD.
 * Only a server that answers (200-with-empty-body, or 404/410) may condemn a
 * link — otherwise a flaky connection would delete good links from the vault.
 */
import { fetchBounded, requestSignal, readBody } from './http.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TIMEOUT_MS = Number(process.env.VAULT_LIVENESS_TIMEOUT_MS || 15000);
const MIN_LIVE_BYTES = Number(process.env.VAULT_LIVE_BYTES || 400);
export const LIVENESS_CONCURRENCY = Number(process.env.VAULT_LIVENESS_CONCURRENCY || 8);

export const embedId = (url = '') => String(url).match(/\/stream\/page\/(\d+)/)?.[1] || '';

/** Classify one embed page. `state`: 'live' | 'dead' | 'unknown'. */
export async function checkEmbed(url) {
  if (!embedId(url)) return { url, state: 'dead', reason: 'unrecognised embed url' };
  let res;
  try {
    res = await fetchBounded(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: requestSignal(TIMEOUT_MS),
    });
  } catch (error) {
    return { url, state: 'unknown', reason: error.message }; // never prune on this
  }
  // a definitive "gone"
  if (res.status === 404 || res.status === 410) return { url, state: 'dead', reason: `HTTP ${res.status}` };
  if (!res.ok) return { url, state: 'unknown', reason: `HTTP ${res.status}` };
  let body = '';
  try {
    body = (await readBody(res)).toString('utf8');
  } catch (error) {
    return { url, state: 'unknown', reason: `body read failed: ${error.message}` };
  }
  if (!body.trim()) return { url, state: 'dead', reason: 'empty player' };
  if (body.length < MIN_LIVE_BYTES || /just a moment|verify you are human|access denied/i.test(body)) return { url, state: 'unknown', reason: 'small/challenge document' };
  if (!/<source[^>]+src\s*=|(?:file|src)\s*:\s*[\"'][^\"']+\.(?:m3u8|mp4)/i.test(body)) return { url, state: 'unknown', reason: 'No recognized player source' };
  return { url, state: 'live', bytes: body.length };
}

/** Bounded-concurrency sweep over a list of embed urls. */
export async function sweepEmbeds(urls, { concurrency = LIVENESS_CONCURRENCY, onResult = null, deadline = 0 } = {}) {
  // Records share embeds (the vault tracks a known shared-id pair), and callers
  // pass the same link twice in a sweep — one request per distinct url.
  const unique = [...new Set((urls || []).filter(Boolean))];
  urls = unique;
  const out = [];
  let cursor = 0;
  const workers = Math.max(1, Math.min(concurrency, urls.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < urls.length) {
      if (deadline && Date.now() > deadline) break; // out of budget: the rest waits
      const url = urls[cursor++];
      const verdict = await checkEmbed(url);
      out.push(verdict);
      onResult?.(verdict);
    }
  }));
  const count = (state) => out.filter((r) => r.state === state).length;
  return { checked: out.length, live: count('live'), dead: count('dead'), unknown: count('unknown'), results: out };
}
