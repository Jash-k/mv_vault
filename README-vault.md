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

Flags: `--dry` (discover + walk, write nothing) · `--max-movies=N` (default 250)
· `--budget-min=N` (default 330) · `--concurrency=N` (default 6) ·
`--kind=movie,series` · `--max-pages=N` · `--checkpoint=N` (default 25).

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
| `src/cli.js` | Entry point — modes, budget, checkpoints, run summary |
| `src/delta.js` | **New-arrival detection** — feeds, retries, alias exclusion |
| `src/feed.js` | `sitemap.xml` + latest-updates readers (path-keyed) |
| `src/sections.js` | Listing registry with per-section pagination |
| `src/walk.js` | Fast pipelined walker (1.2 s/item) |
| `src/store.js` | Atomic writes, union merges, stats |
| `src/verify.js` | Offline integrity check |
| `src/ingest.js` | Ingest an explicit queue into the vault |
| `src/enrich.js` | Backfill TMDB metadata with the key pool |
| `src/titles.js` | Label/path → catalog-title hygiene (rejects non-items) |
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
   previous good file in place.

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
