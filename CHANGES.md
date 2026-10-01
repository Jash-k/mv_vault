# Changelog

## v2.3.0 — posters from the site, and a second look at TMDB

Missing posters had one cause with two faces: artwork came from TMDB alone, only
at the moment a record was added. A release that hit moviesda before TMDB had
artwork — and any record whose TMDB entry has no `poster_path` — stayed blank
forever, because the "needs metadata" rule (`!tmdbId`) skipped every record that
had already matched.

### Fixed

- **`needsMetadata` is `!tmdbId || !poster`.** A matched-but-poster-less record
  is unfinished and is looked at again, by id (`GET /movie/{id}`, one call,
  exact) when we know it.
- **The walker stores the site's own poster.** Item pages carry
  `/uploads/posters/<page-slug-minus-type>.jpg`; `posterFromHtml` picks it up, so
  a new arrival has artwork even when TMDB has none yet.
- **`npm run posters`** (new `--posters=N` mode, no API key): backfills missing
  posters by deriving that URL — page slug, raw slug, record id,
  `slugify(title)-year` — and verifying the response (200 + `image/*` + ≥1 KB
  live; **302 → `/movies.php`, the site's soft 404 = the film has none**; a 5xx or
  a network error is *unknown* and writes nothing). Measured on the live vault:
  it fills 1 of 124 poster-less records today (the rest have no artwork anywhere),
  and the first candidate reproduces 98% of the 360 site posters already stored.
- **TMDB search retries once without the year**, accepting only an exact title
  match: the path year is often wrong or missing, which used to cost a record its
  metadata entirely — but ids are permanent, so a fuzzy match is still refused.
- Each nightly run fills up to 60 missing posters (`--posters=N`, `VAULT_POSTERS_N`).

### Added

- `src/posters.js`, `test/posters.test.js`, `test/tmdb.test.js`; workflow
  dispatch modes **`posters`** and **`enrich`**.
- Run summary gained `postersFilled`; `[vault] posters: N filled · M not published
  by the site · K unknown`.

### Tests

`node --test` — 83 tests (was 66).


## v2.2.0 — re-listed pages, dead-link sweep, junk titles

Fixes three data bugs found in the live vault, and the class of bug behind each.

### Fixed

- **`id: "download-now"`, title `"Download Now"`, year `0`.** The *latest
  updates* rail labels every link with the literal text "Download Now"; the run
  trusted the label. `titleForEntry()` now prefers the page path whenever the
  label is a UI string (`isGenericLabel`), a generic label with no year is
  rejected outright, and an id collision between two different paths is reported
  instead of silently dropping items. `npm run repair` renames the existing
  record (`download-now` → `romanchakam-2026`).
- **Bigg Boss 10 showed 23 episodes; the site has 25.** The season was re-listed
  on a new URL while the old page rotted into an empty stub, and the sitemap
  never lists web-series pages. `-web-series/` and `-season-NN/` shapes are now
  recognised, `listSeries` uses the same listing pipeline as everything else, and
  `config/page-aliases.json` maps re-listed pages onto the record they describe.
  Alias pages are walked on their own cadence with the record's identity locked
  in, and `findSeriesTwin()` unions episodes by season (then title, ≥3 shared
  episodes) — 23 + 20 re-listed = 25, no duplicate record.
- **Sardar 2's HD embeds were dead but still served by the app.** The site
  re-uploads titles; the old player URLs answer HTTP 200 with a 0-byte body, so
  nothing noticed. Every incremental run now ends with a rolling liveness sweep
  (600 records, oldest first, budget-aware): confirmed-dead links are pruned from
  the flat list and the seasons tree, the record is re-walked first (its own page
  then its aliases) so replacements land in the same pass, and a record is never
  emptied — an unfixable one is reported and queued on the 90-minute failure
  ladder. A network error is `unknown` and prunes nothing.

### Added

- `src/liveness.js`, `src/refresh.js`, `src/repair.js`, `src/repair-plan.js`,
  `config/page-aliases.json`, `data/liveness.json` (bookkeeping only).
- Modes/flags: `--refresh[=N]`, `--liveness=N`, `--refresh-limit=N`;
  `npm run repair` (dry-run unless `--apply`), `npm run liveness`.
- `titleForEntry()`; `findSeriesTwin()` season matching; `aliasQueueEntries()`;
  `planLiveness()`; run summary gained `embedsChecked`, `deadLinks`, `refreshed`,
  `pruned`, `stuck`.

### Tests

`node --test` — 66 tests (was 44). New: `test/repair.test.js` (junk titles, the
Bigg Boss union, alias cadence, pruning) and `test/liveness.test.js` (the three
embed states with a stubbed fetch, the sweep, budget cuts, never-empty a record).

### Note for consumers

Nothing changes in the record shape. `verdict`-style deep links keep working: the
junk record was renamed (its old id pointed at a record nobody could search for)
and no other `id` moved.


## v2.1.0 — a run that cannot quietly lose a new release

### Added

| File | What it does |
|---|---|
| `src/schedule.js` | Ladder `12h/1d/3d/7d/30d`, 90-min failure back-off, `dead` after 5 failures, 24-h partial re-checks, absolute `retryAfter` |
| `src/health.js` | `assessWalk` / `combineHealth` / `decideNoEmbeds` — whether a run's verdicts may be written |
| `src/manifest.js` | `data/manifest.json` (+ sha256, `lastAddedAt`) and `data/index.json`, refreshed every checkpoint |
| `data/last-run.json` | Per-run health report (counts, problems, mirror rescues) — read by the workflow + watchdog |
| `data/known-drift.json` | Frozen id-drift allowlist; **new** drift now fails `verify.js` (`--update-allowlist`) |
| `test/*` | 44 tests: schedule, walk classification, HTTP retry/mirror/breaker (real local servers), run health, verify gate |

### Fixed (behaviour)

- **A failed read is no longer an empty page.** `walkItem` throws when the item page is unreadable,
  so a 502/timeout schedules a re-try in 90 minutes instead of advancing the 12h/1d/3d/7d/30d ladder.
  Previously one 502 could defer a live new release by days, and the documented ladder was really
  `3d/7d/30d/never` (the 4th rung computed `NaN` and never fired).
- **Partial walks are re-checked.** A failed hop no longer silently costs an item its other
  qualities: the result is merged and re-walked once after 24 h (union merge — can only add links).
- **Empty verdicts are deferred and gated by run health.** If ≥85 % of a run's walks come back empty
  (site shape change) or ≥30 % are unreadable, the verdicts are written as `failed`, not `empty`.
- **Transport:** mirror fallback (`moviesda34.com` ↔ `moviezda.net`), circuit breaker, `Retry-After`
  support, exponential back-off + jitter, and no retrying of hard 4xx (the 1,179 empty pages no longer
  cost 3 requests each).
- **`upsertRecord` diffs the whole record**, not just `embeds`: season/metadata-only changes now
  report `merged` and stamp `updatedAt` (only 42/2,842 records had one before).
- **`verify.js` gates the publish** in the workflow: `vault.json` ships only when verify passes;
  `state.json` always ships.

### Changed

- `package.json` → v2.1.0, scripts `test` / `manifest` added.
- `.github/workflows/vault.yml` → verify gate, `npm ci --ignore-scripts`, `env:`-based inputs,
  nightly cap 400 / budget 90 min, **two** schedules (02:30 + 08:30 UTC), step summary,
  auto-issue on degraded runs.
- Retry counters are now `retryAfter` (absolute); old entries keep working via the legacy path.
## v2.0.0 — new-arrival detection + a 20× faster walker

Two features, one goal: the vault can now keep itself current instead of being a
one-off scrape.

### Added

| File | What it does |
|---|---|
| `src/delta.js` | **New-arrival detection** — sitemap + latest-updates + widening retries, path-normalised, alias-aware |
| `src/feed.js` | `sitemap.xml` and `/tamil-latest-updates/` readers |
| `src/sections.js` | Listing registry (9 sections / 26 letters / years 2012–2026) with **per-section pagination parameters** |
| `src/store.js` | Atomic JSON writes, union merges (embeds, seasons), stats, record builder |
| `src/walk.js` | Fast pipelined walker — **1.2 s/item vs 24.8 s/item** |
| `src/verify.js` | Offline integrity check (`npm run verify`), wired as a commit gate |
| `data/aliases.json` | 7 alternate URLs that must never be ingested (duplicate guard) |

### Changed

- **`src/cli.js` rewritten** around modes: `--incremental` (new arrivals),
  `--sweep` (every listing), `--letters=a-c`, `--item=<url>`, `--queue=<file>`,
  with `--dry`, `--max-movies`, `--budget-min`, `--concurrency`, `--kind`,
  `--checkpoint`. Discovery de-duplicates by `id`, TMDB enrichment only runs for
  records actually touched, and every run prints a summary.
- **`src/titles.js`** — new `titleFromPath()` so path-only discoveries (sitemap
  entries carry no label) get a real title and year; language/quality tails
  stripped; the *last* year token wins (`/12-12-1950-2017-movie/` is the 2017 film).
- **`src/http.js`** — `moviezda.net` added to the base list (the site 301s there).
- **`src/store.js`** — vault state is no longer pruned; empty pages are retried
  instead of being written off.
- **`.github/workflows/vault.yml`** — `mode` input, a **nightly incremental run at
  02:30 UTC**, and `verify` as a gate before the progress commit.
- **`package.json`** — v2.0.0, ESM, scripts: `scrape`, `incremental`, `sweep`,
  `ingest`, `enrich`, `verify`.
- **`README-vault.md`** — rewritten for the modes, retry model and performance.
- `src/scraper.js` is **untouched** and still ships for reference.

### Data

| | v1 (a3f… HEAD) | v2.0.0 |
|---|---|---|
| Records | 2,700 | **2,837** |
| Movies / series | 2,700 / 0 | 2,797 / **40** |
| Embeds | 6,890 | **7,848** |
| Episodes | — | **367** |
| Tracked items (`state.json`) | 3,920 | 4,057 |
| Size | 1.5 MB raw | 1.79 MB raw / 205 KB gzip |

### Behaviour notes (important for consumers)

- **Movies carry no `kind` key.** "Absent `kind` ⇒ movie" is the contract; only
  series carry `kind: "series"`, plus `seasons[]` and a flattened `embeds[]`.
- **`id` never changes.** It is a permanent deep-link anchor; 139 legacy records
  have an `id` year that predates a later TMDB year correction, and that is by
  design.
- **`data/vault-stats.json` gained `episodes`** (additive).
- **Empty pages are not final.** An item that exists but has no live embed yet is
  retried at +1, +3, +7 and +30 days, tracked in `state.json` under `retries`.
- Pre-existing, unrelated to this change: embeds `96453/96455/96456/96462` are
  shared by `ipl-2025` and `ipl-indian-penal-law-2025` — apparently the same film
  listed twice. Left as-is; it needs a human decision, not a script.

### Upgrading

```bash
npm install          # adds cheerio
npm run verify       # offline integrity check — expect PASS
npm run incremental  # first new-arrival run (use --dry to preview)
```
