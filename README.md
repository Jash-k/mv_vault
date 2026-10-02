# mv_vault

Two flows. One run each. Nothing else.

| Flow | What it checks | Schedule (UTC / IST) |
|---|---|---|
| `new-releases.yml` | `/tamil-2026-movies/` **and** `/tamil-2027-movies/` (all pages each) **and** `/tamil-web-series-download/` (latest 3 pages) | 00:17, 06:17, 12:17, 18:17 / 05:47, 11:47, 17:47, 23:47 |
| `az-archive.yml` | `/tamil-movies/<letter>/?page=N` from a saved cursor, continuing through the letters in the same run | 19:43 / 01:13 next day |
| `tmdb-backfill.yml` | nothing on the site — fills poster/rating/`tmdbId`/`imdbId` for records that are missing them | manual, on demand |

Each scrape run does exactly one thing: **discover → walk → merge → commit**.
There is no queue file, no candidate/staging copy, no artifact, no second job.
The log of the run *is* the report.

**Years are automatic.** The releases flow always reads the current year *and*
the next one, so nothing needs changing at the rollover: `/tamil-2027-movies/`
already exists as a placeholder page, costs one request while empty, and is
picked up the moment a title lands in it. Use `--year=2027` (or the `year` input
in the Actions tab) to run exactly one year by hand.

## Files (this is the whole repo)

```
.github/workflows/new-releases.yml
.github/workflows/az-archive.yml
.github/workflows/tmdb-backfill.yml
src/run.mjs        run one mode: --mode=releases | --mode=az
src/scrape.mjs     listing parse + item walk (movies and series)
src/vault.mjs      load/merge/save vault.json + index.json + state.json
src/tmdb.mjs       optional poster/rating/tmdbId/imdbId (only with TMDB_KEYS)
data/vault.json    your catalogue — shape unchanged
data/index.json    browse index — shape unchanged
data/state.json    per-URL result bookkeeping — shape unchanged
data/az.json       the A–Z cursor: {"letter":"a","page":1,"pass":1}   ← the only new file
package.json · README.md · .gitignore
```

## How the skip logic works (this is the part that keeps runs short)

For every item on a listing:

1. **Already in `vault.json` with embeds** → skipped, zero requests.
2. **Known empty/unreleased** → skipped until its retry time (24 h in the
   releases flow, 7 days in the A–Z flow). A page that could not be *read*
   (5xx/timeout) is retried sooner, following the old 90 min → 24 h backoff.
3. Otherwise → walked now and merged.

So the releases flow only ever spends requests on genuinely new titles, and an
A–Z pass only spends them on letters that actually have something new. Stored
items are never re-walked, so nothing you already have can be downgraded:
embeds are **unioned** in, never replaced, and a series' flat `embeds[]` is always
rebuilt from `seasons[]` so the two can never disagree.

## TMDB: automatic for new records, plus a backfill

* On every scrape run, records touched by that run get a TMDB lookup when they are
  missing artwork — fills the `poster`, `rating`, `tmdbId` and `imdbId` fields.
* **`tmdb-backfill.yml`** (Actions → Run workflow) is the one-off for everything
  already in the vault: it walks the records that have no `tmdbId` or no `poster`,
  newest first in file order, and stops cleanly on the budget:

  ```bash
  node src/run.mjs --mode=tmdb --limit=200            # 200 records, ~2 min
  node src/run.mjs --mode=tmdb --stale-days=90        # also re-try old misses
  node src/run.mjs --mode=tmdb --dry                  # look up, log, write nothing
  ```

* A record TMDB has no exact match for is remembered in `state.json` as
  `tmdbMiss: { "<record id>": "<date>" }` and is **not** retried on the next run
  (it is *not* written into `vault.json`). `--stale-days=N` re-tries those older
  than N days.
* If the key is missing/invalid or TMDB rate-limits, the run says so and **stops** —
  it never marks hundreds of records as "no match" because the API was unhappy.
* Only exact title+year matches are accepted (TV endpoint first for series, movie
  endpoint as fallback). Two exact matches with no year = refused, left as-is.

## The A–Z cursor

`data/az.json` is written after every page:

* page finished → next page;
* letter finished → next letter (**same run**, it does not stop per letter);
* `z` finished → `{"letter":"a","page":1,"pass":N+1}`, i.e. a fresh pass, which is
  how re-uploads and late additions in old letters get re-checked;
* budget/`--max-items` hit **mid-page** → the cursor does **not** move, so the
  rest of that page is picked up next run;
* a listing that fails to load → cursor stays, 3 failures in a row stops the run.

## Reading the log

```
=== mv_vault · az · 2026-10-03T01:13:00Z ===
budget 300min · max-items ∞ · tmdb on
vault 2864 records · state 4084 tracked urls
pass 2 · resuming at letter j page 1
[j p1] 20 items · 3 to walk
  + Jolly O Gymkhana (2026)        added · 16 embeds · poster · 36 req · 17.0s
  ± Bigg Boss Season 10 (2026)     merged · 20 embeds · poster · 43 req · 17.8s
  = Gaja (2026)                    unchanged · 4 embeds · poster · 12 req · 9.1s
  ~ Untitled (2027)                no embeds yet (empty #1) · 6 req · 4.2s
  ! Gana (2026)                    HTTP 503 (url) · 1 failed
=== summary · az · pass 2 ===
cursor         j/2
items walked   21  (added 8 · merged 12 · unchanged 1)
...
```

`+` added · `±` merged · `=` unchanged · `~` page is live but has no embeds yet ·
`!` could not be read · `·` listing/cursor notes. The same table goes to the
workflow's **Summary** tab.

A run goes **red** only when something structural happened: a listing could not
be read at all, or 10+ items were walked and *none* produced embeds (i.e. the hop
chain or the host changed). One flaky item never fails a run.

## The walk (unchanged from the old pipeline, verified live 2026-10-03)

```
item → /<title>-original-movie/ → /<title>-1080p-hd-movie/ → /download/<slug>/
     → download.moviespage.xyz/download/file/<id>
     → movies.downloadpage.xyz/download/page/<id> → play.onestream.today/stream/page/<id>
```

Series insert a season layer and one slug per episode. Quality policy is
unchanged: **1080p + 720p only**, falling back to 360p/other rips if a film has
neither. Request envelope per item is bounded (≤3 groups, ≤4 resolution pages,
≤8 slug pages, ≤10 confirmations), so a pass cannot run away.

`screenshots`/direct MP4s are still never stored — the onestream ids are what
make the catalogue durable.

## Running locally

```bash
npm install
node src/run.mjs --mode=releases --dry --max-items=3       # safe: scrapes, logs, writes nothing
node src/run.mjs --mode=releases --year=2027 --dry         # just check the 2027 folder
node src/run.mjs --mode=az       --dry --only=agadha       # one item, cursor untouched
node src/run.mjs --mode=tmdb     --limit=200 --dry         # backfill preview
node src/run.mjs --mode=releases --budget-min=25           # writes data/, no commit
node src/run.mjs --mode=releases --budget-min=25 --commit  # writes and pushes
```

Local runs never push unless you add `--commit` (the workflows pass it for you).
Flags: `--budget-min=N` · `--max-items=N` · `--year=YYYY` · `--commit` ·
`--commit-every=N` (default 100 releases / 200 az — a long run never loses
everything if the runner dies) · `--dry` · `--only=text` (manual filter, cursor
untouched) · `--tmdb-limit=N` (default 150 per scrape run) · `--limit=N` and
`--stale-days=N` (tmdb mode only).

## Slimming your existing repo (one command)

Copy the new files in, then delete the old machinery:

```bash
git rm -r --ignore-unmatch -q src scripts test docs config .github/actions .github/workflows/ci.yml \
  CHANGES.md TEST-RESULTS.md README-vault.md SHA256SUMS.txt \
  data/known-drift.json data/aliases.json data/liveness.json data/manifest.json \
  data/vault-stats.json data/last-run.json data/releases-state.json data/archive-state.json \
  data/maintenance-state.json
# then: copy src/, .github/workflows/*.yml, package.json, README.md, data/az.json from here
npm install --package-lock-only     # refresh the lock file for the trimmed dependency set
git add -A && git commit -m "simplify: two flows, one run each"
```

Keep `data/vault.json`, `data/index.json` and `data/state.json` exactly as they
are — the new code reads and writes those three in place.

## Notes

* **Host**: every moviesda domain (`moviesda34.com`, `moviesdatamil.net`,
  `moviezda.net`) currently redirects to **moviezda.net**, so that is the host we
  fetch (`LIVE` in `src/scrape.mjs`). What we *store* stays on
  `https://moviesda34.com/...` so `pageUrl`, `state.json` keys and your app's
  links never fork when the domain moves again — change one line if you'd rather
  store the live host.
* **TMDB** is optional. With the `TMDB_KEYS` secret (or `TMDB_API_KEY`), new
  records get a poster, rating, `tmdbId`, `imdbId`, and `tmdb-backfill.yml` fills
  the old ones. Without a key every run still works and says
  `tmdb skipped (no key)`.
* **Sessions/identity**: a re-listed series page (e.g. the 2026 Bigg Boss page)
  merges into the existing record when the **same season** shares 3+ episodes.
  A different season of the same show stays a separate record, exactly like your
  current Bigg Boss Season 9 / Season 10 entries.
* **First A–Z run after the switch**: your old pipeline left ~1,179 pages marked
  "empty" on retry ladders that are already due, so the first pass re-checks them
  (1–2 requests each) before settling. From then on they follow the 7-day window
  and a pass only costs the listing pages plus whatever is genuinely new.
* **First run of a letter**: existing records are skipped, so a full A–Z pass
  only costs the listing pages plus the walk of whatever is new.
* `data/vault.json`, `data/index.json` and `data/state.json` keep their exact
  key order and types; verified against the current vault (nothing removed,
  series `embeds[]` == `seasons[]` for every record).
