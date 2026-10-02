/**
 * Shared HTTP helpers for the vault scraper.
 * Mirrors + retries + polite delays — same discipline as the mv_scrapper
 * moviesda module (this repo is independent on purpose: the vault is a slow,
 * one-time historic pass; mv_scrapper stays untouched).
 *
 * v2.1 — "the run must not fail because one request did":
 *
 *   · RETRY POLICY: 429/408/5xx and network errors are retried with exponential
 *     backoff + jitter; a `Retry-After` header is honoured. A hard 4xx (404/410
 *     — the page is gone) is NOT retried: retrying it three times wastes the
 *     run's request budget on all 1,179 empty pages.
 *   · MIRROR FALLBACK: moviesda34.com and moviezda.net serve the same paths.
 *     When one host is down or hanging, the same pathname is retried on the
 *     sibling before the item is declared unreadable. Without this, a primary
 *     that 301s/flaps takes the whole nightly run down with it.
 *   · CIRCUIT BREAKER: after BREAKER_AFTER consecutive failures a host is
 *     parked for BREAKER_MS, so a dead host cannot burn the time budget at
 *     12s timeout × 3 attempts per request. It re-probes automatically.
 */
// moviesda34.com now 301s to moviezda.net; moviezda.net is listed so a future
// switch of the canonical host needs no code change. Item URLs stay normalised
// to moviesda34.com so state.json keys never fork across a domain move.
export const BASES = ['https://moviesda34.com', 'https://moviezda.net', 'https://movies.downloadpage.xyz'];
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Hosts that mirror each other: the same pathname returns the same page. */
export const SITE_MIRRORS = String(process.env.VAULT_MIRRORS || 'https://moviesda34.com,https://moviezda.net')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MIRROR_ENABLED = process.env.VAULT_MIRROR !== '0';

const TIMEOUT_MS = Number(process.env.VAULT_TIMEOUT_MS || 12000);
const ATTEMPTS = Math.max(1, Number(process.env.VAULT_ATTEMPTS || 3));
const BACKOFF_MS = Math.max(100, Number(process.env.VAULT_BACKOFF_MS || 700));
const MAX_RETRY_AFTER_MS = 86_400_000;

/** Statuses that mean "the page is gone" — never worth a second request. */
const HARD_STATUS = new Set([400, 401, 403, 404, 405, 410, 451]);
const isRetryableStatus = (status) => !HARD_STATUS.has(status) && (status === 408 || status === 429 || status >= 500);

/** Per-host circuit breaker. */
const BREAKER_AFTER = Number(process.env.VAULT_BREAKER_AFTER || 6);
const BREAKER_MS = Number(process.env.VAULT_BREAKER_MS || 120_000);
const health = new Map(); // host → { fails, downUntil }

/** Run-level counters, printed in the CLI summary and last-run.json. */
export const httpStats = { requests: 0, retries: 0, mirrorRescues: 0, hardFailures: 0, hostDowns: 0, bytes: 0 };

export function requestSignal(timeoutMs = TIMEOUT_MS) {
  const deadline = Number(process.env.VAULT_DEADLINE_MS || 0);
  if (deadline && Date.now() >= deadline) throw new Error('Run deadline reached');
  return AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline ? deadline - Date.now() : timeoutMs)));
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, Number(process.env.VAULT_DEADLINE_MS || Infinity) - Date.now()))));
/** Polite pacing with jitter so the archive walk never looks like a flood. */
export const politeDelay = () => sleep(Number(process.env.VAULT_DELAY_MS || 280) + Math.floor(Math.random() * 220));

const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));

export function absolute(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

/** Is this host parked by the breaker right now? */
export function hostDownUntil(url) {
  try {
    const { host } = new URL(url);
    const entry = health.get(host);
    return entry && entry.downUntil > Date.now() ? entry.downUntil : 0;
  } catch {
    return 0;
  }
}

function noteFailure(url) {
  try {
    const { host } = new URL(url);
    const entry = health.get(host) || { fails: 0, downUntil: 0 };
    entry.fails += 1;
    if (entry.fails >= BREAKER_AFTER && entry.downUntil < Date.now()) {
      entry.downUntil = Date.now() + BREAKER_MS;
      httpStats.hostDowns += 1;
      console.warn(`[http] ${host}: ${entry.fails} consecutive failures — parked for ${Math.round(BREAKER_MS / 1000)}s (mirror will carry the run)`);
    }
    health.set(host, entry);
  } catch { /* unparseable url — nothing to track */ }
}

function noteSuccess(url) {
  try {
    const { host } = new URL(url);
    const entry = health.get(host);
    if (entry) { entry.fails = 0; entry.downUntil = 0; }
  } catch { /* ignore */ }
}

/** Same pathname on the sibling site host — '' when there is no sibling. */
export function mirrorUrlsFor(url) {
  if (!MIRROR_ENABLED) return [];
  let parsed;
  try { parsed = new URL(url); } catch { return []; }
  const self = SITE_MIRRORS.find((base) => new URL(base).host === parsed.host);
  if (!self) return []; // download/confirm hosts: no known sibling, never guess
  return SITE_MIRRORS.filter((base) => new URL(base).host !== parsed.host)
    .map((base) => `${base}${parsed.pathname}${parsed.search}`);
}

class HttpError extends Error {
  constructor(message, status, { retryable = false, headers = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
    this.headers = headers;
  }
}

/** One request, with its own attempt loop. Never called for a parked host. */
async function requestOnce(url, referer) {
  const signal = requestSignal(TIMEOUT_MS);
  try {
    const res = await fetchBounded(url, {
      headers: referer ? { ...HEADERS, Referer: referer } : HEADERS,
      redirect: 'follow',
      signal,
    });
    if (!res.ok) {
      const retryable = isRetryableStatus(res.status);
      await res.body?.cancel();
      throw new HttpError(`HTTP ${res.status}`, res.status, { retryable, headers: res.headers });
    }
    const body = (await readBody(res, 4 * 1024 * 1024)).toString('utf8');
    httpStats.bytes += Buffer.byteLength(body);
    return body;
  } finally {
    // AbortSignal.timeout also bounds the body read.
  }
}

export function retryAfterMs(error) {
  const header = error?.headers?.get?.('retry-after');
  const seconds = Number(header);
  if (header == null) return 0;
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, MAX_RETRY_AFTER_MS)) : 0;
}

/** Attempt loop for a single URL (no mirroring here). */
async function fetchOneHost(url, { referer } = {}) {
  let lastError = new Error('not attempted');
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (Number(process.env.VAULT_DEADLINE_MS || Infinity) <= Date.now()) throw new Error('Run deadline reached');
    try {
      const body = await requestOnce(url, referer);
      noteSuccess(url);
      return body;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof HttpError ? error.retryable : true; // network/timeout
      if (!retryable) {
        httpStats.hardFailures += 1;
        // A missing/forbidden item is not evidence that its host is offline.
        throw error;
      }
      if (attempt < ATTEMPTS - 1) {
        httpStats.retries += 1;
        const wait = error.status === 429 && retryAfterMs(error) ? retryAfterMs(error) : jitter(BACKOFF_MS * 2 ** attempt);
        await sleep(wait);
      }
    }
  }
  noteFailure(url);
  throw lastError;
}

/**
 * Fetch with retries, then (for site hosts) with mirror fallback.
 * Throws only when every attempt on every mirror failed — the caller can then
 * classify the item as FAILED instead of EMPTY, which is the whole point.
 */
export async function fetchWithRetry(url, { referer, allowDown = false } = {}) {
  const parked = hostDownUntil(url);
  if (parked && !allowDown) {
    // the host is known dead — do not spend attempts on it, go straight to the mirror
    const mirrors = mirrorUrlsFor(url);
    for (const mirror of mirrors) {
      if (hostDownUntil(mirror)) continue;
      try {
        const body = await fetchOneHost(mirror, { referer });
        httpStats.mirrorRescues += 1;
        return body;
      } catch { /* mirror is down too */ }
    }
    throw new HttpError(`host parked (${new URL(url).host})`, 0, { retryable: false });
  }

  try {
    return await fetchOneHost(url, { referer });
  } catch (error) {
    const mirrors = mirrorUrlsFor(url);
    if (!mirrors.length) throw error;
    for (const mirror of mirrors) {
      if (hostDownUntil(mirror)) continue;
      try {
        const body = await fetchOneHost(mirror, { referer });
        httpStats.mirrorRescues += 1;
        console.warn(`[http] mirror rescue: ${new URL(url).host} → ${new URL(mirror).host}${new URL(mirror).pathname}`);
        return body;
      } catch { /* try the next sibling */ }
    }
    throw error;
  }
}

/** Path → try every mirror; absolute URL → as-is. */
export async function fetchPage(urlOrPath) {
  if (/^https?:\/\//i.test(urlOrPath)) {
    return { html: await fetchWithRetry(urlOrPath), base: new URL(urlOrPath).origin };
  }
  let lastError = new Error('no mirror answered');
  for (const base of BASES) {
    try {
      return { html: await fetchWithRetry(base + urlOrPath), base };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Read at most `max` bytes of a body (some CDNs ignore Range). */
export async function readCapped(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  while (got < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  try { await reader.cancel(); } catch { /* closed */ }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

export function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseTitleYear(label = '') {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  const year = Number(text.match(/\((19|20)\d{2}\)/)?.[0]?.replace(/[()]/g, '')) || 0;
  const title = text.replace(/\((19|20)\d{2}\)/g, '').replace(/\s+/g, ' ').trim();
  return { title, year };
}


const paced = new Map();
export async function fetchBounded(input, options = {}) {
  let url = new URL(input);
  const allowed = new Set(String(process.env.VAULT_ALLOWED_HOSTS || 'moviesda34.com,moviezda.net,movies.downloadpage.xyz,download.moviespage.xyz,play.onestream.today,api.themoviedb.org').split(','));
  for (let hop = 0; hop < 6; hop++) {
    if (!['http:', 'https:'].includes(url.protocol) || !allowed.has(url.hostname)) throw new Error(`Unapproved request/redirect host: ${url.hostname}`);
    if (httpStats.requests >= Number(process.env.VAULT_MAX_REQUESTS || 100000)) throw new Error('Request budget exhausted');
    httpStats.requests++; // reserve before awaiting so concurrent workers cannot overshoot
    const interval = Number(process.env.VAULT_MIN_INTERVAL_MS ?? 120);
    const slot = Math.max(Date.now(), paced.get(url.host) || 0);
    paced.set(url.host, slot + interval);
    await sleep(slot - Date.now());
    const signal = requestSignal(Number(process.env.VAULT_TIMEOUT_MS || 15000));
    const res = await fetch(url, { ...options, redirect: 'manual', signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal });
    if (res.status >= 300 && res.status < 400 && options.redirect !== 'manual' && res.headers.get('location')) {
      await res.body?.cancel();
      url = new URL(res.headers.get('location'), url); continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

/** Bounded body read; reject oversize documents instead of accepting a truncated parser result. */
export async function readBody(res, maxBytes = 4 * 1024 * 1024) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > maxBytes) throw new Error('Response body exceeds size budget');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
