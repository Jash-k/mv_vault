/**
 * Shared HTTP helpers for the vault scraper.
 * Mirrors + retries + polite delays — same discipline as the mv_scrapper
 * moviesda module (this repo is independent on purpose: the vault is a slow,
 * one-time historic pass; mv_scrapper stays untouched).
 */
export const BASES = ['https://moviesda34.com', 'https://movies.downloadpage.xyz'];
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const TIMEOUT_MS = Number(process.env.VAULT_TIMEOUT_MS || 12000);
const RETRIES = 2;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polite pacing with jitter so the archive walk never looks like a flood. */
export const politeDelay = () => sleep(Number(process.env.VAULT_DELAY_MS || 280) + Math.floor(Math.random() * 220));

export function absolute(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

export async function fetchWithRetry(url, { attempt = 0, referer } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: referer ? { ...HEADERS, Referer: referer } : HEADERS,
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (attempt < RETRIES) {
      await sleep(900 * (attempt + 1));
      return fetchWithRetry(url, { attempt: attempt + 1, referer });
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
