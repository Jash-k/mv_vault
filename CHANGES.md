# Changes

## v2.0.1 — posters actually fill in

The `enrich` path existed but could not finish the job: it trusted `results[0]`
from TMDB search, and it skipped every record that already had a `tmdbId` — so
records that matched without a poster were stuck that way forever.

- **Guarded matching** (`src/tmdb.js`): a candidate must match the title, and the
  year when both are known (±1). Exact title + exact year wins. This is what stops
  a Tamil film from receiving a popular same-named film's poster; a missing poster
  is the better outcome. Titles too short to match safely (`"4"`) and near-misses
  are rejected rather than fudged.
- **Poster is now fetched by id**, not from the search payload
  (`/movie/{id}?append_to_response=external_ids`), so the poster always belongs to
  the id we matched — and `imdbId` comes back in the same call.
- **The repair pass** (`src/enrich.js`) re-fetches records that have a `tmdbId`
  but no poster, by exact id. Existing 62 poster-less matches are now fixable.
- **`data/enrich-unmatched.json`** — every title that could not be matched, with
  the reason. No silent failures.
- **Honest counters** in `vault-stats.json`: `withPoster` / `withoutPoster`.
- **`mode=enrich` in the workflow** — run it from the Actions tab.
- Tested against a mock TMDB with deliberate traps (wrong-year same-title first,
  popular-result mismatch, short numeric title, poster-less match) — all four
  handled as intended; `verify` stays PASS after a full 719-record sweep.

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
