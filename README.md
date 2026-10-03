# mv_vault

Three flows. One run each. Nothing else.

| Flow | What it checks | Schedule (UTC / IST) |
|---|---|---|
| `new-releases.yml` | the year folders only: `/tamil-2026-movies/` **and** `/tamil-2027-movies/` (all pages each) — they carry movies **and** series — **plus the stored-link health check** | 00:17, 06:17, 12:17, 18:17 / 05:47, 11:47, 17:47, 23:47 |
| `az-archive.yml` | `/tamil-movies/<letter>/?page=N` from a saved cursor, continuing through the letters in the same run | 19:43 / 01:13 next day |
| `enrich.yml` | no scraping — poster, rating, `tmdbId`, `imdbId` and the **category** for records missing them | manual, on demand |

### Which folders the releases flow reads

**The year folder only.** `/tamil-2026-movies/` lists movies *and* series (379
items today: 312 movie-shaped, 67 series-shaped, e.g. `Love (2026)`,
`Hunkkaar The Roar`, `Bigg Boss Season 10`), so reading `/tamil-web-series-download/`
as well was doing the same job twice and costing 3 extra listing pages every run.

* `with_series = true` (`--with-series`) adds that folder back (latest 3 pages).
  Worth it only for a couple of pre-2026 series that are listed **nowhere else** —
  today that is `90s A Middle Class Biopic (2025)` and `1000 Babies (2024)`. Every
  other series page on that folder is also on the A–Z index, so it keeps being
  refreshed there (the A–Z flow re-walks stored series on a 168 h window).
* Nothing already stored is affected either way — this only changes where new
  episodes are noticed first.

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
node src/run.mjs --mode=enrich --limit=0              # all eligible records
node src/run.mjs --mode=enrich --dry                  # look up and log, write nothing
node src/run.mjs --mode=enrich --stale-days=30        # re-try old misses / site guesses
node src/run.mjs --mode=enrich --concurrency=8        # 8 parallel lookups (default 4)
node src/run.mjs --mode=enrich --verify-ids           # re-match stored ids that are wrong
node src/run.mjs --mode=enrich --only=toxic           # one record, by title/id/path
```

**All 11 TMDB keys go in ONE secret, comma-separated** — Actions → Settings →
Secrets → `TMDB_KEYS` = `key1,key2,key3,…,key11` (no spaces needed). If you only
have the old single secret it still works (`TMDB_API_KEY`), and the workflows pass
whichever exists.

The keys are a pool, used round-robin:

* a **429** parks *that one key* for 10 minutes and the same request is retried on
  the next key — one throttled key never slows the run down;
* a **401/403** retires *that key* and moves on, so a bad key among the eleven is
  harmless;
* the run only says `! all TMDB keys are rate-limited` or `! every TMDB key was
  rejected` when **every** key is out, and then it stops without marking anything.

The log prints the pool on the first line: `tmdb 11 keys · 1 parked · 4 parallel
lookups`.

Or Actions → **Enrich (posters, ratings, categories)** → Run workflow.
Measured throughput: ~480 records/minute single-threaded, ~2× that with the default
4 parallel lookups, so the whole backfill is a few minutes inside the 20-minute budget. It is idempotent —
run it as often as you like, in slices if you prefer.

Safety: each TMDB call is retried once, and a single unreachable request is
skipped (`· TMDB network error (2/5) — skipping this one, continuing`), so one
DNS blip cannot end a 20-minute run. A missing/invalid key, a rate-limit, or five
network errors in a row **stops the loop** and says so; it never marks hundreds of
records as "no match" because the API was unhappy, and nothing is lost — rerun to
continue where it stopped.

A note on accuracy: TMDB ids already stored in your vault are trusted for **their
own media type** and looked up by id — no churn on 2,500 existing records. So when
the report says `Agadha (2026) · te · tamil-dubbed-movie`, that is TMDB's own
`original_language` for that film — this site republishes Telugu/Malayalam releases
with Tamil audio, and the category is exactly the field that separates them.

Three matching rules that matter:

* **A stored id that only exists as the other media type is used when the title
  matches exactly.** `Indian Police Force`, `Killer Soup`, `Kaiyum Kalavum`,
  `Mathagam`, `Parampara` are series filed under movie-shaped paths: their id
  resolves as a **TV** entry, so they now get `tamil-series` / `tamil-dubbed-series`
  and the log says so:
  `· Indian Police Force (2024)  TMDB id 201009 is "Indian Police Force", a series — categorised as one`
* **A series record is never matched to a film**, even with the same title and
  year. Two different works can share both, and a film's poster and language on a
  series record is worse than no match. `Love (2026)` is exactly this case: its
  stored id belongs to *The Love Hypothesis*, so that id is ignored and the site
  fallback gives `tamil-series`.
* **A wrong stored id is reported, never silently rewritten**:
  `· Toxic (2025)  TMDB id 338969 is "The Toxic Avenger Unrated" — title differs, kept as it was (use --verify-ids to re-match)`

`--verify-ids` (Actions input `verify_ids`) is the opt-in fix for those: it
re-searches by title+year and replaces the id (with poster/rating/language) **only**
when an exact match is found; if nothing better exists the record keeps exactly what
it had (`· … no better exact match found, kept`). One title at a time is also
possible: `node src/run.mjs --mode=enrich --only=toxic --verify-ids`.
Records TMDB had no match for are remembered in `state.json` as `tmdbMiss`
(never written into `vault.json`) and are skipped next time unless `--stale-days` asks.
A record with **no category at all** is always eligible, even if it carries a
`tmdbMiss` marker — the marker only means "TMDB has no entry", and it used to stop
the site fallback from ever running, which is how records could end up marked but
left uncategorised. That is fixed: the next enrich run visibly classifies them
(`· … no TMDB match → site says tamil-dubbed-movie`).

## When two runs overlap

The workflows share one concurrency group, so a second run normally waits. If a
manual run does overlap a long one, the later run **merges instead of rebasing**:

```
· another run pushed while this one was crawling — merging and pushing again
· branch moved: merged 2864 local + 2864 remote records → 2864
· committed: enrich: +0 new, 0 merged, 0 walks (merged with a concurrent run)
```

The two generations union at the JSON level (records, embeds, seasons and
categories all merge — a link or a category is never dropped by a merge; the
metadata side with the newer `updatedAt` wins), then a normal fast-forward push.
Nothing is ever force-pushed, and a run whose data could not be published **fails
visibly** instead of reporting success.

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

**Every listing now ends with a line that accounts for every item**, so "it only
takes series" / "it skipped the first title" can always be answered from the log:

```
· releases: 379 items (312 movies, 67 series) → 0 walked ·
  skipped: 305 stored · 64 series — inside its refresh window · 10 stored (another path)
```

"0 walked" there is not a failure: every movie on that folder was already in the
vault, and every series was inside its refresh window. The first item of a listing
is skipped for exactly the same reason as any other stored/recent item — there is
nothing special about position. `--verbose` (Actions input `verbose`) prints one
line per item, skips included, whenever you want the item-by-item trace.

## The A–Z cursor

`data/az.json` is written after every page:

* page finished → next page; letter finished → next letter (**same run**, it does
  not stop at the end of each letter);
* `z` finished → the cursor rolls to `{"letter":"a","page":1,"pass":N+1}` and the
  run **stops**. One pass per run: the next scheduled run starts the new pass.
  (It used to roll over and keep going, which on an already-stored catalogue
  looped the whole alphabet ~15 times until the 5-hour budget was gone.)
* budget/`--max-items` hit **mid-page** → the cursor does **not** move;
* a listing that fails to load → cursor stays, 3 failures in a row stops the run.

A pass with nothing new to walk is therefore cheap (listing pages only, ~15–20
min) and writes almost nothing: `data/` is only rewritten when a walk actually
changed something, not for every listing page.

### Stored links are checked, because they DO die

A stored record was never looked at again — and that is wrong. When the site
rebuilds a release the stream IDs change, and the old ones go **dead**: the URL
still answers HTTP 200, but with an **empty body** (0 bytes) instead of the ~12 KB
player page. Measured on this vault:

```
movie             stored ids   still offered by the page   old ids today
Toxic (2025)           3                 0                  0 bytes — dead
Mandaadi (2026)        3                 0                  0 bytes — dead
Bethlehem Kudumba…     3                 0                  0 bytes — dead
Romanchakam (2026)     4                 4                  alive
Sunday (2008)          2                 2                  alive
```

The site had swapped those three from their earlier release to `(Original)` and
rebuilt the files. Nothing in the old pipeline could notice, so the vault kept
handing out links that play nothing.

Every releases run now probes the stored links of the records on that year folder
(one request per movie, two for a series: first + newest episode):

* **dead** (empty body, or 404/410) → the page is re-walked, the fresh verified
  links are merged in, and **only the URLs proven dead are dropped** — everything
  still alive is kept;
* **alive** → nothing happens at all (no walk, one request);
* **unknown** (403/429/5xx/timeout/network) → **never** drops anything. A bad
  minute on the host is not proof that a link is gone.

```
links          probing 370 stored records on this folder · movie=top link · series=first+newest episode
  ⚡ Toxic (2025)                             DEAD LINK → re-walked · 4 verified · 3 stored → 4 kept (3 dead removed)
links          436 probes on 370 records · 3 dead · 3 re-walked and repaired (9 dead links removed)
```

Recorded records are only re-walked when a probe fails, so a healthy run costs
~380 requests (~1 min) and walks nothing. A record walked in the last hour is
skipped (it was verified when it was stored).

**Series are handled differently on purpose.** The download page shows only the
latest ~20 episodes, but older episodes stay alive — Bigg Boss S10's page no
longer lists episodes 1–7, yet all seven still play. So a series is never rebuilt
from what the page happens to list: new episodes are unioned in (they already
were), and a stored episode is removed **only** if its own link probed dead. If
every link of an episode dies, the episode goes too, so the app never shows an
episode that cannot play; a later walk re-adds it if the site uploads it again.

`check_all = true` (`--check-all`) widens the check from this year's folder to the
whole vault — measured: **2,906 records / 3,007 probes in ~2½ minutes**, and the day
it was added every one of those was alive (the deaths cluster in the new-release
window, which is why the per-run check exists). Cheap enough to run weekly by hand,
or make it the default if the old catalogue ever starts rotting.
`no_link_check = true` (`--no-link-check`) skips the check for one run.

One related note on series: an episode is only *found* when its page is walked. A
series on this year's folder is re-walked every 24 h; a pre-2026 series (Bigg Boss
Season 9, say) is re-walked when its A–Z letter comes round (weekly). If a running
old show needs a faster window, the probe is the cheap place to hang it — say the
word and I'll make a dead/absent episode trigger an immediate re-walk.

### Recovery sweep (the old walker's lost titles)

`--sweep-empty` (Actions → **A–Z archive** → `sweep_empty`) is a **one-off recovery
run**. It ignores the cursor, walks `a→z` and re-checks every page the **older
walker** marked "empty" — the verdicts that predate the movie/series fix, which is
where the missing back-catalogue titles are:

```
$ node src/run.mjs --mode=az --sweep-empty --budget-min=300
[a] 344 items · 107 tracked-empty pages to re-check
=== sweep summary ===
pages re-checked 107
recovered        8 records (8 new · 0 merged into existing)
still empty      14 (genuinely nothing published yet — the page has no download links at all)
not reached      77 (budget ran out — rerun with the same command to continue)
```

* It **never touches the cursor**, so the normal A–Z flow carries on where it was.
* It is idempotent and resumable: run it again until `recovered 0` and
  `not reached 0`. Each page it re-checks gets the current walker stamp, so after
  the sweep those pages follow the normal 7-day window and it never repeats itself.
* "still empty" is a real answer, not a bug: a good share of the A–Z index is
  placeholder pages for titles the site lists but has not published links for
  (checked by hand: `/vizhithiru-2017-movie/`, `/vajram-2015-tamil-movie/`,
  `/alti-2020-tamil-movie/` contain zero download links). Those pages are not lost —
  they are re-checked weekly, so the record appears the moment links are added.

Use `--only-empty` if you want the older, path-based version of the same idea
(only pages already known empty/failed).

## Reading the log

```
· tmdb 11 keys · 4 parallel lookups
· releases: 439 items (313 movies, 126 series) → 0 walked ·
  skipped: 305 stored · 124 series — inside its refresh window · 10 stored (another path)
[a p4] 20 items · 3 to walk
  + Aindham Vedham (2024)        added · 8 embeds · poster · 18 req · 9.6s
  ± Bigg Boss Season 10 (2026)   merged · 20 embeds · +1 episode · poster · 42 req · 15.0s
  = Love (2026)                  series · refresh in 13h
  ~ Untitled (2027)              no embeds yet (empty #1) · 3 req · 4.3s
  ! Gana (2026)                  HTTP 503 (url)
=== summary · releases ===
links          370 checked · 3 dead · 3 repaired · 9 removed · 0 pulled · 0 unreachable-kept
=== summary · az · pass 1 ===
cursor         a/6
items walked   8  (added 5 · merged 1 · unchanged 0)
empty/failed   2 empty · 0 failed · 106 skipped (already stored/recent)
series refresh 2 stored series re-walked for new episodes
categories     tamil-movie 1469 · tamil-dubbed-movie 14
```

`+` added · `±` merged · `=` unchanged/skipped · `~` live but no embeds yet ·
`!` could not be read · `+N episodes` = new episodes merged into a stored series.
The `· <flow>: N items … → M walked · skipped: …` line is printed for every
listing/batch and is the one to read when something looks missing — it names the
exact reason each item was left alone. `⚡ <title> DEAD LINK …` means a stored link
had gone dead and the page was re-walked to replace it.
The same table goes to the workflow's **Summary** tab.

A run goes **red** only when something structural happened: a listing could not
be read at all, or 10+ items were walked and *none* produced embeds (the hop
chain or the host changed). One flaky item never fails a run.

## First runs after this upgrade (expected, not errors)

* The releases flow will re-walk the ~76 stored series once (refresh window
  expired) — roughly 15–25 minutes, so the first run may stop on its budget and
  finish on the next one.
* The A–Z pages the old pipeline left as "empty" (1,160 of them) still carry old
  verdicts, so running the **recovery sweep** once is what gets those titles back.
  Do that on purpose instead of waiting for the cursor: Actions → A–Z archive →
  `sweep_empty` = true, and repeat until it reports `recovered 0`. The workflow's
  340-minute timeout fits a full sweep (~2 h measured).
* The **enrich** run wants all eligible records in one go: with 11 keys and 4
  parallel lookups, the whole backfill is a few minutes. Set `limit` to `0`.

## Running locally

```bash
npm install
node src/run.mjs --mode=releases --dry --max-items=3       # safe: scrapes, logs, writes nothing
node src/run.mjs --mode=releases --year=2027 --dry         # just the 2027 folder
node src/run.mjs --mode=releases --with-series --dry       # + the old series folder
node src/run.mjs --mode=az       --dry --only=agadha       # one item, cursor untouched
node src/run.mjs --mode=az       --sweep-empty --budget-min=300   # recovery sweep
node src/run.mjs --mode=az       --only-empty --budget-min=60
node src/run.mjs --mode=enrich   --limit=50 --dry
node src/run.mjs --mode=releases --budget-min=25 --commit  # writes and pushes
```

Local runs never push unless you add `--commit` (the workflows pass it for you).
Flags: `--budget-min=N` · `--max-items=N` · `--year=YYYY` · `--check-all` ·
`--no-link-check` · `--with-series` · `--only-empty` ·
`--sweep-empty` · `--verbose` · `--refresh-days=N` (re-walk stored movies older
than N days; off by default) · `--commit` · `--commit-every=N` (default 100
releases / 200 az) · `--dry` · `--only=text` · `--tmdb-limit=N` ·
`--concurrency=N` · `--verify-ids` · `--limit=N` / `--stale-days=N` (enrich only;
`--only=text` works in enrich too).

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
