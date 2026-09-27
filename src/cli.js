#!/usr/bin/env node
/**
 * moviesda-vault CLI — resumable historic scrape of durable onestream embeds.
 *
 * Usage:
 *   node src/cli.js --letters=a-c --max-pages=3 --max-movies=150
 *   node src/cli.js --letters=z --item=https://moviesda34.com/some-movie/   (single re-walk)
 *
 * Env:
 *   TMDB_KEYS=k1,k2,k3     comma-separated; rotates on 401/404/429/network
 *   VAULT_DELAY_MS=280     base polite delay (jitter added)
 *   VAULT_BUDGET_MIN=330   stop gracefully before GitHub's 6h job cap
 *
 * Resume: data/state.json remembers every processed item URL; each run skips
 * them. State + vault are committed after the run (workflow does the commit).
 */
import { listLetter, scrapeMovieEmbeds } from './scraper.js';
import { enrichWithTmdb } from './tmdb.js';
import { loadData, saveData, upsertMovie } from './store.js';
import { parseTitleYear, politeDelay } from './http.js';
import { slugify } from './http.js';
import { keyCount } from './tmdb.js';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const LETTERS = (arg('letters', 'a-z') || 'a-z').replace(/\s/g, '');
const MAX_PAGES = Number(arg('max-pages', process.env.VAULT_MAX_PAGES || 0)) || 0;
const MAX_MOVIES = Number(arg('max-movies', process.env.VAULT_MAX_MOVIES || 250));
const BUDGET_MS = Number(arg('budget-min', process.env.VAULT_BUDGET_MIN || 330)) * 60 * 1000;
const SINGLE_ITEM = arg('item', '');

const started = Date.now();
const deadline = started + BUDGET_MS;
const letters = LETTERS.includes('-')
  ? (() => {
      const [a, b] = LETTERS.split('-');
      const out = [];
      for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c += 1) out.push(String.fromCharCode(c));
      return out;
    })()
  : LETTERS.split(',');

console.log(`[vault] letters=${letters.join('')} maxPages=${MAX_PAGES || 'all'} maxMovies=${MAX_MOVIES} budget=${Math.round(BUDGET_MS / 60000)}min`);
console.log(`[vault] tmdb keys loaded: ${keyCount()}`);

const { state, vault } = loadData();
state.done = state.done || {};
state.letters = state.letters || {};

let scraped = 0;
let enriched = 0;
let stops = 0; // movies with zero embeds (layout change or exhausted page)

function isDone(url) {
  return Boolean(state.done[url]);
}

async function processItem(item) {
  const { title, year } = parseTitleYear(item.label);
  if (!title) return;
  const id = `${slugify(title)}${year ? `-${year}` : ''}`;

  if (isDone(item.url)) return;
  if (Date.now() > deadline) throw new Error('BUDGET');

  console.log(`  → ${title}${year ? ` (${year})` : ''}`);
  const embeds = await scrapeMovieEmbeds(item.url, { deadline });

  if (!embeds.length) {
    stops += 1;
    state.done[item.url] = { at: new Date().toISOString(), empty: true };
    return;
  }

  const meta = await enrichWithTmdb({ title, year });
  if (meta.tmdbId) enriched += 1;
  await politeDelay();

  upsertMovie(vault, {
    id,
    title,
    year: meta.year || year,
    pageUrl: item.url,
    embeds,
    poster: meta.poster || '',
    rating: meta.rating || 0,
    tmdbId: meta.tmdbId || 0,
    imdbId: meta.imdbId || '',
  });
  state.done[item.url] = { at: new Date().toISOString(), embeds: embeds.length };
  scraped += 1;
}

try {
  if (SINGLE_ITEM) {
    await processItem({ url: SINGLE_ITEM, label: '' });
  } else {
    outer: for (const letter of letters) {
      console.log(`[vault] letter ${letter.toUpperCase()}`);
      state.letters[letter] = { startedAt: new Date().toISOString() };
      const items = await listLetter(letter, {
        maxPages: MAX_PAGES,
        onPage: (l, p, count, total) => console.log(`  page ${p}: ${count} items (total ${total})`),
      });
      for (const item of items) {
        try {
          await processItem(item);
          await politeDelay();
          if (scraped >= MAX_MOVIES) {
            console.log(`[vault] movie cap reached (${MAX_MOVIES}) — stopping for this run`);
            break outer;
          }
        } catch (error) {
          if (error.message === 'BUDGET') break outer;
          console.warn(`  ! failed: ${error.message}`);
        }
      }
      state.letters[letter].finishedAt = new Date().toISOString();
    }
  }
} finally {
  saveData({ state, vault });
  const withEmbeds = vault.filter((m) => m.embeds?.length).length;
  console.log('[vault] RUN SUMMARY', JSON.stringify({
    newMovies: scraped,
    tmdbMatched: enriched,
    emptyMovies: stops,
    vaultTotal: withEmbeds,
    embedLinks: vault.reduce((n, m) => n + (m.embeds?.length || 0), 0),
    minutes: Math.round((Date.now() - started) / 60000),
  }));
}
