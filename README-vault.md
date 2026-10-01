# moviesda-vault

Historic vault of **durable onestream embed links** for Tamil movies and web
series. Built to power a click-and-play "Vault" catalog in JaSH ViBeS: the links
stored here do not rot (unlike direct MP4 tokens, which die within hours), so the
app can play straight from the JSON with zero server-side resolution.

**Independent by design** — this repo does not touch
[Jash-k/mv_scrapper](https://github.com/Jash-k/mv_scrapper) or its workflows.

**Current data:** 2,837 records (2,797 movies + 40 web series) · 7,848 embeds ·
367 episodes · 1.79 MB raw / 205 KB gzip.

## What it collects

- **Movies** — 1080p + 720p embeds.
- **Web series** — every episode, per-episode 1080p + 720p, grouped into
  `seasons[]` **and** flattened into `embeds[]` for backwards compatibility.
- **Quality policy (locked):** 1080p + 720p; 360p/other rips only as a fallback
  when neither exists. Series follow the same rule per episode.
- `pageUrl` is kept on every record as a permanent anchor: if an onestream ID
  ever dies, the item can be re-walked from its page URL.

## Record shapes (`data/vault.json`)

`kind` is **absent on movies** — treat a missing `kind` as `"movie"`. (2,700
legacy records never had it and newly walked movies do not add it either; only
series carry `kind`.)

```jsonc
// movie
{ "id": "raayan-2024", "title": "Raayan", "year": 2024,
  "pageUrl": "https://moviesda34.com/raayan-2024-tamil-movie/",
  "embeds": [ { "quality": "1080p", "url": "https://play.onestream.today/stream/page/101977" },
              { "quality": "720p",  "url": "https://play.onestream.today/stream/page/101973" } ],
  "poster": "https://image.tmdb.org/t/p/w500/…", "rating": 7.1,
  "tmdbId": 1234567, "imdbId": "tt31905828", "addedAt": "2026-09-29T…" }

// web series — episodes grouped, AND flattened for old consumers
{ "id": "aakali-rajyam-2026", "title": "Aakali Rajyam", "year": 2026, "kind": "series",
  "pageUrl": "…",
  "seasons": [ { "season": 1, "episodes": [ { "episode": 1, "embeds": [
        { "quality": "1080p", "url": "…" }, { "quality": "720p", "url": "…" } ] } ] } ],
  "embeds": [ { "quality": "1080p", "url": "…", "season": 1, "episode": 1 } ],
  "poster": "", "rating": 0, "tmdbId": 0, "imdbId": "" }
```

An app that ignores `kind`/`seasons` still works: it renders one tile from the
flat `embeds[]` and plays episode 1. An app that reads `seasons[]` gets an
episode picker.

`id` is a **permanent deep-link anchor** (`slugify(title)-year`, committed at
first insert). It is never rewritten, even when TMDB later corrects a title's
year — 139 legacy records carry that drift and it is deliberate.

## Modes

| Run | What it does | Cost |
|---|---|---|
| `--incremental` | **New arrivals.** sitemap + latest-updates + items whose retry window opened | 2 listing requests + N items |
| `--sweep` | Every listing the site publishes (the safety net) | ~1,000 listing pages |
| `--letters=a-c` | Historic A–Z walk, resumable | long |
| `--item=<url>` | Re-walk exactly one item | 1 item |
| `--queue=<file>` | Walk an explicit JSON queue | N items |
| `--refresh[=N]` | **Liveness + repair pass only** (no discovery): re-check N records' embeds, prune the dead ones, re-walk what it can fix | ~1 request per embed |

Flags: `--dry` (discover + walk, write nothing) · `--max-movies=N` (default 250)
· `--budget-min=N` (default 330) · `--concurrency=N` (default 6) ·
`--kind=movie,series` · `--max-pages=N` · `--checkpoint=N` (default 25) ·
`--liveness=N` (records swept per incremental run, default 600, `0` disables) ·
`--refresh-limit=N` (dead-link records re-walked per run, default 40).

Two ways to run the repair tooling:

```bash
npm run repair                       # DRY RUN: list exactly what would change
npm run repair -- --apply            # junk titles, alias merges, dead-link sweep
npm run repair -- --apply --only=dead --ids=sardar-2-2026   # scope one record
npm run liveness                     # = --refresh=600, no discovery
```

Checkpoints write the vault atomically every 25 items, so a killed run loses
seconds, not hours.

### How new-arrival detection works

Three independent sources, diffed by **path** against what is already stored:

1. **`sitemap.xml`** — every item page on the site, newest `<lastmod>` first
   (548 URLs today). The primary signal.
2. **`/tamil-latest-updates/`** — the site's own "what's new" rail (25 items),
   which occasionally runs ahead of the sitemap.
3. **Due retries** — items that previously returned *no live embeds*. A page
   existing is not a page that plays: new releases routinely appear with their
   embed links added days later. Such items are retried on a widening schedule
   (`1, 3, 7, 30` days), so an item that was empty when it launched is picked up
   automatically once it goes live. This is the case the detector exists for.

Two rules learned the hard way:

- **Compare paths, never hosts.** The site 301s to `moviezda.net` while the item
  URLs are stored under `moviesda34.com`; a host-based diff reports the entire
  sitemap as new.
- **Never ingest an alias.** `data/aliases.json` lists 7 paths that are alternate
  URLs of titles already stored — they are excluded from discovery *and* from the
  retry queue, so a daily run can never create a duplicate record.

### Re-listed pages, dead links and junk titles (v2.2)

Three ways the catalogue went wrong in production, and what now stops each one.

**1. A title read off a button.** moviesda's *latest updates* rail writes the
literal text "Download Now" into every link, so a run that trusted the label
stored `id: "download-now"`, `title: "Download Now"`, `year: 0` — and every later
rail item collided with it and was dropped (`de-duplicated N duplicate id(s)`).
`titleForEntry()` now prefers the **path** whenever the label is a UI string
(`isGenericLabel`), `isRejected()` refuses a generic label with no year, and a
collision between two *different* paths is shouted about in the log instead of
being silently de-duplicated. `planJunkRepairs()` (used by `npm run repair`)
re-derives the identity of any record still titled that way.

**2. A series re-listed on a new URL.** The site moved *Bigg Boss* season 10 from
`/bigg-boss-season-10-tamil-web-series/` (now an empty navigation stub) to
`/bigg-boss-2026-tamil-web-series/` (episodes 6–25; the first five were deleted).
The old page still existed, so the vault kept 23 episodes and never saw 24–25.
Now:

- `config/page-aliases.json` maps a re-listed path to the record it describes.
  Alias pages are **never** ingested as new arrivals, and they are walked on a
  cadence (`refreshHours`, default 24) with the record's own id/title/year locked
  in — so new episodes on the new URL land in the same record instead of minting
  a second one or going stale.
- `findSeriesTwin()` unions a re-listed page into the stored record by **season**
  first and title second (a 106-episode season 9 shares episode numbers 6–25 with
  season 10; title alone would have corrupted both), requiring ≥3 shared episodes.
- The union is additive: 23 stored + 20 re-listed = **25 episodes**, no record
  deleted, deep links intact (`npm test` covers exactly this case).

**Repairing data written before v2.2** — see [`REPAIR-v2.2.md`](REPAIR-v2.2.md):
`npm run repair` (dry-run) lists the junk titles, alias merges and dead links in
the existing vault; `npm run repair -- --apply` fixes them in place.

**3. Embeds that stopped playing.** The site re-uploads titles and leaves the old
player URLs serving an empty document (HTTP 200, 0 bytes — so status code alone
proves nothing). `src/liveness.js` checks the body, and every incremental run ends
with a rolling sweep (`--liveness`, default 600 records, oldest-checked first,
capped by the remaining budget). Confirmed-dead links are pruned from the flat
list *and* the seasons tree, after a re-walk of the record's page and its aliases
so replacements are merged in first. A record is **never emptied**: if every link
is dead and the re-walk finds nothing, the record survives, the run reports it, and
it goes straight onto the 90-minute failure ladder. A network error is `unknown`
and prunes nothing.

`data/liveness.json` keeps the per-record timestamps (kept out of `vault.json`, so
the nightly timestamp churn does not rewrite the 1.8 MB deliverable).

### Reliability model (v2.1) — never miss a release because of a flaky request

The run distinguishes two very different failures, and the distinction is what keeps new
releases from being quietly deferred:

| Verdict | Meaning | Next look |
|---|---|---|
| `empty` | the page **was read** and has no live embed yet (normal for a new release) | 12h → 1d → 3d → 7d → 30d, then exhausted |
| `failed` | the page **could not be read** (5xx/timeout/reset) — nothing was learned | **90 minutes**, ladder untouched; `dead` after 5 in a row |
| `partial` | the walk succeeded but a hop failed (item IS stored) | re-walked once after 24h and merged (union — can only add links) |

A run also judges itself (`src/health.js`): if ≥85% of walked items come back empty, or ≥30% are
unreadable, the run is **degraded** — "no embeds" is then recorded as `failed` instead of `empty`
(no ladder damage), the run is flagged in `data/last-run.json`, and the workflow files an issue.
A degraded run is *never* a silent one.

Transport: `src/http.js` retries 429/408/5xx with exponential back-off + jitter (honouring
`Retry-After`), **does not** retry hard 4xx, falls back to the sibling mirror (the same pathname on
`moviezda.net` when `moviesda34.com` is down) and parks a host after N consecutive failures via a
circuit breaker. Counters land in the run summary (`mirrorRescues`, `hostsParked`).

Publishing: `verify.js` gates the commit — `vault.json` (and the derived manifest/index/stats) ship
**only if verify passed**; `state.json` and `last-run.json` always ship, so a bad night stays
resumable and visible. Two schedules run (`02:30` and `08:30` UTC) so anything that failed at night
is retried the same day.

```bash
node --test                                   # 44 tests, offline, ~1.4s
node src/verify.js                            # gates drift, stats, manifest sha
node src/cli.js --incremental --dry --max-movies=10   # preview a night, write nothing
VAULT_STRICT=1 node src/cli.js --incremental  # exit 2 when the run is degraded
```

**Retry backlog.** The vault tracks **1,178 item pages that existed but had no
live embed when they were walked** (mostly the 2012–2016 back-catalogue and
unreleased titles). On the first incremental runs all of them are due, so part of
each run's budget goes to re-checking them. New arrivals are always walked first
(the queue is ordered fresh → retries), `--max-movies` caps the spend, and a page
is retried at most 4 times (`1+3+7+30` days) before it is marked exhausted — so
the backlog drains and then stops costing anything.

```bash
npm run incremental           # or: node src/cli.js --incremental
node src/cli.js --incremental --dry --max-movies=10   # preview, write nothing
node src/cli.js --sweep --max-pages=2 --dry           # safety-net preview
```

### Coverage beyond A–Z

`src/sections.js` is the listing registry: 26 letter buckets, years 2012–2026,
web series, HD, Tamil dubbed, latest updates, Tamilrockers and two actor-collection
indexes. Each section declares **its own pagination parameter** — the web series
section pages with `?get-page=N`, everything else with `?page=N`; getting this
wrong silently caps a section at one page.

Two sections legitimately yield 0 items: `/tamil-movies-collection/` and
`/moviesda-tamil-collections/` are *indexes of actor collections* (level-2
listings). Their movies are already covered by the year/A–Z sections; they are
still fetched so that an item published only there would be caught.

## Performance

`src/walk.js` plans and memoises the whole chain (item page → folder tree →
episode pages → quality variants) and pipelines independent requests across items.

| | Legacy chain (`src/scraper.js`) | `src/walk.js` |
|---|---|---|
| Movies, matched sample, identical embeds | 24.8 s/item | **1.2 s/item** |
| Full archive (~2,800 items) | ≈ 27.7 h | ≈ 80 min |
| 12-item `--incremental` run, end to end | — | **14.5 s wall** incl. startup + discovery |

Series cost scales with episode count — one 19-episode series with folder
traversal is ~80 requests, about 75 s. `src/scraper.js` is untouched and still
ships for reference.

## Integrity check

```bash
npm run verify     # node src/verify.js — offline, no network, no deps
```

Checks: ids unique and stable · titles/years present · embeds non-empty,
well-formed and not duplicated *within* a record · `embeds[]` and `seasons[]`
agree for series · stats match the vault · state coverage counted. It exits
non-zero on any breakage and is wired as a **gate before the workflow commits**.
Two informational notes are printed, both pre-existing and expected: 139
legacy-id/year drifts and 4 embeds shared between two duplicate-film records
(`ipl-2025` / `ipl-indian-penal-law-2025`).

## Files

| Path | Purpose |
|---|---|
| `data/vault.json` | **The deliverable** — the catalog consumed by the app |
| `data/vault-stats.json` | Counters: movies, series, episodes, links, last update |
| `data/state.json` | Resume state — every processed item, plus retry counters |
| `data/aliases.json` | Alternate URLs that must never be ingested (dedupe guard) |
| `data/incoming.json` | Standing queue of verified titles awaiting a walk |
| `data/last-run.json` | The run's self-reported health (the watchdog and the workflow read it) |
| `data/manifest.json` | Counters + `lastAddedAt` + sha256 — "has anything changed?" in 0.4 KB |
| `data/index.json` | Browse index (id/title/year/kind/rating/poster) — 107 KB gzip vs 226 KB |
| `data/known-drift.json` | **Frozen** id-drift + shared-embed allowlist; new drift fails verify |
| `src/cli.js` | Entry point — modes, budget, checkpoints, run summary |
| `src/delta.js` | **New-arrival detection** — feeds, retries, partial re-checks, alias exclusion |
| `src/schedule.js` | When an item is worth looking at again (ladder, failure back-off, dead pages) |
| `src/health.js` | Run health — when an "empty" verdict may be written at all |
| `src/manifest.js` | Derived consumer files: `manifest.json` (sha256 + freshness) and `index.json` |
| `src/feed.js` | `sitemap.xml` + latest-updates readers (path-keyed) |
| `src/sections.js` | Listing registry with per-section pagination |
| `src/walk.js` | Fast pipelined walker (1.2 s/item) |
| `src/store.js` | Atomic writes, union merges, stats |
| `src/verify.js` | Offline integrity check |
| `src/ingest.js` | Ingest an explicit queue into the vault |
| `src/enrich.js` | Backfill TMDB metadata with the key pool |
| `data/liveness.json` | Per-record embed-check timestamps (nightly sweep bookkeeping) |
| `config/page-aliases.json` | Hand-maintained: re-listed pages → the record they describe |
| `src/titles.js` | Label/path → catalog-title hygiene (rejects non-items) |
| `src/liveness.js` | Is this embed still playable? (live / dead / unknown) |
| `src/refresh.js` | Prune confirmed-dead links, re-walk a record, the rolling sweep |
| `src/repair.js` | **`npm run repair`** — junk titles, alias merges, dead links (dry-run by default) |
| `src/repair-plan.js` | The repair rules, as pure functions (unit-tested) |
| `src/scraper.js` | Original sequential chain — kept for reference |

## How to run (GitHub Actions)

1. Push this repo and set **Settings → Secrets → Actions → new secret:**
   `TMDB_KEYS` (comma-separated TMDB v3 keys, rotated automatically on
   exhaustion/429 — omit for poster-less data).
2. It runs **nightly at 02:30 UTC (08:00 IST)** in `--incremental` mode: new
   arrivals only, a few minutes, then commits its own progress. Delete the
   `schedule:` block in `.github/workflows/vault.yml` if you prefer manual runs.
3. **Actions → Vault Scrape → Run workflow** for anything else: pick
   `incremental`, `sweep` (full safety net) or `letters` (historic A–Z walk,
   resumable — dispatch repeatedly and it continues where it stopped).
4. Every run verifies the vault before committing; a failed check leaves the
   previous good file in place. The nightly run also sweeps 600 records' embeds
   for dead links (see v2.2 above) — nothing extra to schedule.

## Local CLI

```bash
npm install
TMDB_KEYS=k1,k2 node src/cli.js --incremental --max-movies=25
TMDB_KEYS=k1,k2 node src/cli.js --letters=a-c --max-pages=2
npm run verify
```

## App wiring (JaSH ViBeS)

Point the app at the raw file — everything else is automatic:

```
VAULT_JSON_URL=https://raw.githubusercontent.com/<you>/moviesda-vault/main/data/vault.json
```

The app caches it for 30 minutes and renders the Vault rail on the home page plus
the full `/vault` browse page. Playback uses the stored onestream embeds directly
— silent, instant, no resolve chain.
