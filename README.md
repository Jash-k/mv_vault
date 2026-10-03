# mv_vault

Three flows. One run each. Nothing else.

| Flow | What it checks | Schedule (UTC / IST) |
|---|---|---|
| `new-releases.yml` | `/tamil-2026-movies/` **and** `/tamil-2027-movies/` (all pages each) **and** `/tamil-web-series-download/` (latest 3 pages) | 00:17, 06:17, 12:17, 18:17 / 05:47, 11:47, 17:47, 23:47 |
| `az-archive.yml` | `/tamil-movies/<letter>/?page=N` from a saved cursor, continuing through the letters in the same run | 19:43 / 01:13 next day |
| `enrich.yml` | no scraping — poster, rating, `tmdbId`, `imdbId` and the **category** for records missing them | manual, on demand |

Each scrape run does exactly one thing: **discover → walk → merge → commit**.
There is no queue file, no candidate/staging copy, no artifact, no second job.
The log of the run *is* the report.

## Files (this is the whole repo)

```
.github/workflows/new-releases.yml
.github/workflows/az-archive.yml
.github/workflows/enrich.yml
src/run.mjs        run one mode: --mode=releases | --mode=az | --mode=enrich
src/scrape.mjs     listing parse + item walk (movies and series)
src/vault.mjs      load/merge/save vault.json + index.json + state.json
src/tmdb.mjs       optional poster/rating/tmdbId/imdbId/originalLanguage
data/vault.json    your catalogue
data/index.json    browse index (i, t, y, k, c, r, p) — `c` = category
data/state.json    per-URL result bookkeeping (now also remembers `kind` + walk version)
data/az.json       the A–Z cursor: {"letter":"a","page":1,"pass":1}
package.json · README.md · .gitignore
```

## Movie or series is decided from the PAGE, not the URL

The site publishes series under movie-shaped paths all the time:

```
/ayali-season-01-2023-tamil-movie/    → episodes sit straight on the page
/aindham-vedham-2024-tamil-movie/     → links to /aindham-vedham-season-01/
/aindham-vedham-season-01/            → single-segment path, not even an "item" link
```

Walking those as movies finds no 1080p/720p folder, returns "empty", and the
title never reaches the vault — which is why A–Z and year-list series were
missing. Now the item page is fetched **once** and then:

1. episode slugs (`/download/…-epi-NN/`) or season folders on the page → **series walk**;
2. otherwise → **movie walk**;
3. if the movie walk yields nothing, the series walk gets one try on the same HTML.

Both shapes of series are handled: with a quality layer
(item → `*-season-01/` → `*-season-01-1080p/` → episode slug) and flat
(item → episode slug directly). Flat episodes have no quality token, so they are
stored as `HD` — the same convention your vault already uses — never dropped.

**Walk version.** Every verdict in `state.json` is stamped with the walker
version. A verdict written by an older walker is re-tried instead of trusted, so
a fix like the one above takes effect on the next pass rather than waiting out a
7-day empty window. That is why your existing ~1,179 "empty" pages get re-checked
after this upgrade.

## Categories (TMDB-derived, one field)

```json
{
  "id": "achyuta-avataaram-2026",
  "category": "tamil-dubbed-movie",
  "originalLanguage": "kn",
  "categorySource": "tmdb"
}
```

| value | meaning |
|---|---|
| `tamil-movie` | Tamil-origin film |
| `tamil-dubbed-movie` | non-Tamil film, Tamil audio |
| `tamil-series` | Tamil-origin series |
| `tamil-dubbed-series` | non-Tamil series, Tamil audio |

* `originalLanguage` is TMDB's `original_language` (`ta`, `hi`, `kn`, `te`…) — the
  **only** reliable signal, because every item page says `Language: Tamil` (that
  is the audio track, not the origin).
* A record that already has a `tmdbId` is looked up **by that id** — one call, and
  it cannot accidentally take a different film's language from a title search.
  Records without one use an exact title+year search (2 calls).
* **No TMDB match** → the site's own `/tamil-dubbed-movies/` section decides
  (listed there = dubbed), stored with `"categorySource": "site"` so you can see
  which ones are guesses and let a later enrich run upgrade them.
* **Nothing found anywhere** → `category` stays empty. It is never invented.
* `index.json` carries the same value as a short key `c`, so a browse/filter view
  does not have to download the 1.9 MB vault.
* These fields appear only once known, so untouched records stay byte-identical.
  Key order: `… year, [kind], category, originalLanguage, categorySource, pageUrl …`

### Filling them in

```bash
node src/run.mjs --mode=enrich --limit=200            # 200 records
node src/run.mjs --mode=enrich --limit=0              # as many as the budget allows
node src/run.mjs --mode=enrich --dry                  # look up and log, write nothing
node src/run.mjs --mode=enrich --stale-days=30        # re-try old misses / site guesses
```

Or Actions → **Enrich (posters, ratings, categories)** → Run workflow.
Measured throughput: ~480 records/minute, so the full 2,864-record backfill takes
about **6 minutes** and fits the default 20-minute budget. It is idempotent —
run it as often as you like, in slices if you prefer.

Safety: a missing/invalid key or a TMDB rate-limit **stops the loop** and says so;
it never marks hundreds of records as "no match" because the API was unhappy.
Records TMDB had no match for are remembered in `state.json` as `tmdbMiss`
(never written into `vault.json`) and are skipped next time unless `--stale-days` asks.

## How the skip logic works

For every item on a listing:

1. **Stored** → skipped, zero requests (movies are done).
2. **Stored under a different page path** (the site re-lists titles as
   `/x-2023-tamil-movie-1/`, `/x-tamil-movie-moviesda/`) → skipped using the state
   file, so it is not re-walked on every run.
3. **Stored series** → re-walked when its window has passed, and new episodes are
   unioned in. This is not optional: the site adds episodes to running shows, and
   one transient failure would otherwise leave an episode missing forever.
   Window: **24 h** on the releases flow, **168 h** in the A–Z flow.
4. **Known empty** → skipped until its retry time (24 h releases, 7 days A–Z),
   *unless* the verdict came from an older walker.
5. Otherwise → walked now.

Embeds are **unioned** in, never replaced, and a series' flat `embeds[]` is always
rebuilt from `seasons[]`, so the two can never disagree.

## The A–Z cursor

`data/az.json` is written after every page:

* page finished → next page; letter finished → next letter (**same run**);
* `z` finished → `{"letter":"a","page":1,"pass":N+1}` — a fresh pass;
* budget/`--max-items` hit **mid-page** → the cursor does **not** move;
* a listing that fails to load → cursor stays, 3 failures in a row stops the run.

`--only-empty` (Actions input `only_empty`) makes a run re-check **only** pages
already known empty/failed — a one-off backlog sweep. Useful right after this
upgrade, or once the ~1,179 legacy empty pages matter to you more than new items.

## Reading the log

```
[a p4] 20 items · 3 to walk
  + Aindham Vedham (2024)        added · 8 embeds · poster · 18 req · 9.6s
  ± Bigg Boss Season 10 (2026)   merged · 20 embeds · +1 episode · poster · 42 req · 15.0s
  = Love (2026)                  series · refresh in 13h
  ~ Untitled (2027)              no embeds yet (empty #1) · 3 req · 4.3s
  ! Gana (2026)                  HTTP 503 (url)
=== summary · az · pass 1 ===
cursor         a/6
items walked   8  (added 5 · merged 1 · unchanged 0)
empty/failed   2 empty · 0 failed · 106 skipped (already stored/recent)
series refresh 2 stored series re-walked for new episodes
categories     tamil-movie 1469 · tamil-dubbed-movie 14
```

`+` added · `±` merged · `=` unchanged/skipped · `~` live but no embeds yet ·
`!` could not be read · `+N episodes` = new episodes merged into a stored series.
The same table goes to the workflow's **Summary** tab.

A run goes **red** only when something structural happened: a listing could not
be read at all, or 10+ items were walked and *none* produced embeds (the hop
chain or the host changed). One flaky item never fails a run.

## First runs after this upgrade (expected, not errors)

* The releases flow will re-walk the ~76 stored series once (refresh window
  expired) — roughly 15–25 minutes, so the first run may stop on its budget and
  finish on the next one.
* The first A–Z pass re-walks the ~1,179 pages the old pipeline left as "empty",
  because their verdicts predate the walker fix. Use `only_empty` to do that
  deliberately, or just let the cursor pass do it.

## Running locally

```bash
npm install
node src/run.mjs --mode=releases --dry --max-items=3       # safe: scrapes, logs, writes nothing
node src/run.mjs --mode=releases --year=2027 --dry         # just the 2027 folder
node src/run.mjs --mode=az       --dry --only=agadha       # one item, cursor untouched
node src/run.mjs --mode=az       --only-empty --budget-min=60
node src/run.mjs --mode=enrich   --limit=50 --dry
node src/run.mjs --mode=releases --budget-min=25 --commit  # writes and pushes
```

Local runs never push unless you add `--commit` (the workflows pass it for you).
Flags: `--budget-min=N` · `--max-items=N` · `--year=YYYY` · `--only-empty` ·
`--commit` · `--commit-every=N` (default 100 releases / 200 az) · `--dry` ·
`--only=text` · `--tmdb-limit=N` · `--limit=N` / `--stale-days=N` (enrich only).

## Notes

* **Host**: every moviesda domain (`moviesda34.com`, `moviesdatamil.net`,
  `moviezda.net`) redirects to **moviezda.net**, so that is the host we fetch
  (`LIVE` in `src/scrape.mjs`). What we *store* stays on
  `https://moviesda34.com/...` so `pageUrl`, state keys and your app's links never
  fork when the domain moves again — change one line if you'd rather store the
  live host.
* **Sessions/identity**: a re-listed series page merges into the existing record
  when the **same season** shares 3+ episodes; a different season of the same show
  stays a separate record, like your Bigg Boss Season 9 / Season 10 entries.
* `vault.json`, `index.json` and `state.json` keep their existing key order and
  types (`index.json` gains only the new `c` key). Verified against your current
  vault: nothing removed, every series' `embeds[]` == `seasons[]`.
