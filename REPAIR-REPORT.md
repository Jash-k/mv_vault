# mv_vault repair and metadata backfill

**Checked:** 9 October 2026 · **Base commit:** `a4df982909f20a5070606e38c15aff046f8e6973`

## Result

The complete `data/vault.json` contains **all 7,350 original records**, with **920 newly assigned TMDB IDs**. It is the full catalogue, not a partial export. It is **not 100% metadata-complete**: **793 records still have no sufficiently corroborated TMDB ID**. Those records were retained without fabricated metadata.

| Missing field | Before | After |
|---|---:|---:|
| TMDB ID | 1,713 | **793** |
| Poster | 348 | **277** |
| IMDb ID | 1,946 | **1,036** |
| Nonzero rating | 2,461 | **1,573** |
| Category | 40 | **18** |

A zero rating may mean TMDB has no votes; it is not necessarily a failed lookup. Some verified TMDB entries have no poster or IMDb ID. TMDB is community-maintained, so verified identity does not guarantee every supplied field is correct.

## Bigg Boss Season 10

- Preserved record ID: `bigg-boss-season-10`.
- Increased **26 → 32 episodes**, adding **27–32**; episode/day numbering follows the source.
- Read both episode pages, including `?page=2`, and checked the source confirmation page for each numbered stream reference.
- No existing links were removed. Actual video playback and future link availability were **not** tested or guaranteed.
- Season 9 remains a separate record, retaining its 103 stored episodes. The source still has gaps; no episodes were invented.
- Both seasons now use **TMDB TV ID 72908**, explicitly corroborated as the Tamil programme using the source's host **Vijay Sethupathi**, season numbers, and corresponding TMDB air years. Each has its own season poster. The generic English title alone was not enough to select the regional programme.

Source pages checked:
- https://moviezda.net/bigg-boss-season-10-web-series/
- https://moviezda.net/bigg-boss-season-10-web-series/?page=2
- https://moviezda.net/bigg-boss-2026-tamil-web-series/
- https://moviezda.net/bigg-boss-2025-tamil-season-9/
- https://www.themoviedb.org/tv/72908

## Why the scheduled updates missed episodes

1. Releases defaulted to current/next-year **movie folders**, omitting the separate series listing where Bigg Boss was being updated.
2. The series walker did not traverse pagination on item, season, or quality folders.
3. The **24-hour refresh window** could delay a show until a later scheduled run. The actual workflow runs every six hours, not just once per day.
4. Old alias state could identify a returning series as a completed movie.

### Repairs

- Read the latest three series-listing pages **by default**; `--no-series` explicitly opts out.
- Add stored current-year **Moviesda** series as a fallback, excluding isaiDub pages from the wrong walker. Oldest checks are prioritized within this fallback.
- Refresh series after **five hours**, before the next six-hour schedule, with older walker versions retried.
- Follow linked, same-folder pagination; de-duplicate slugs and avoid pagination links being interpreted as season/quality folders.
- Enforce bounds/deadlines. Partial walks are flagged for retry rather than silently treated as complete.
- Merge episode data, preserving existing records and links.
- Preserve the existing serialized workflow writer/concurrency settings.

## Metadata matching and limitations

All six supplied API keys were validated. Keys were used privately and are **not included** in files, reports, patches, or archives.

The initial eligible set contained **2,519 records**, including previously missed records and existing IDs missing artwork, IMDb IDs, or ratings. Existing IDs were generally retained; this was **not a full identity re-verification of all 5,637 previously assigned IDs**.

The backfill used:
- Unicode/punctuation normalization and compact-title searches.
- Canonical titles, official TMDB alternative titles, and translations.
- TV **season-air year**, rather than requiring every season to equal the series' first-air year.
- Source-page cast/director corroboration for ambiguous years, transliteration variants, and same-name films.
- Small spelling differences only with two cast matches or a director plus cast match, a title-similarity threshold, and additional year/number safeguards.
- Regional reality-show safeguards: a Tamil dub page is not itself evidence of original language.
- A final cross-check of **776 newly matched movie records with available source cast credits**: no remaining source-credit contradictions or unavailable checks.

Example: the stored year on `baby-girl-2025` pointed toward the unrelated American *Babygirl*. Source credits identified Nivin Pauly, Lijomol Jose, and Jaffer Idukki, so the final metadata correctly uses *Baby Girl*, TMDB **1101020**, not that unrelated film. The record's original ID, title, site year, and links were intentionally preserved.

### Unresolved records

`reports/unresolved-metadata.csv` lists all **793** records still without a TMDB ID:
- **738:** no unique, sufficiently corroborated match.
- **37:** search unavailable or too broad to establish a unique match. **Not confirmed TMDB absences.**
- **18:** source evidence did not corroborate the initial candidate; original metadata was restored.

The original catalogue can contain inaccurate titles, years, credits, or categories. Existing unverified site categories were not globally rewritten. One pre-existing inconsistency (`sabash-babu-1993`: stored English language with Tamil-original category) was left untouched rather than guessed. The code now keeps language/category updates consistent when fresh TMDB metadata is applied.

## Validation

- **27 automated regression tests passed on Node 22.23.3**, the workflow's supported major version.
- Live Bigg Boss recovery succeeded; a subsequent dry run collected all 32 episodes again with no additional changes.
- Live final metadata dry-run for `baby-girl-2025` completed without further changes.
- All 7,350 records, IDs, ordering, titles, years, page URLs, and kinds preserved.
- Existing assigned TMDB IDs preserved.
- No old embed URLs removed; only Bigg Boss S10 received new links.
- Nested season episodes and flat embeds checked for every series.
- `index.json` regenerated and checked against every vault record.
- Workflow YAML parsed; JavaScript syntax checks and `git diff --check` passed.
- No GitHub push or production deployment performed.

See `reports/validation.json`, `reports/test-results.txt`, `reports/metadata-matches.json`, and `reports/source-credit-validation.json`.

## Install and run

Back up the repository, then copy the archive contents into its root. Use **the matching `data/vault.json`, `data/index.json`, and `data/state.json` together**. Do not overwrite newer live data blindly if scheduled jobs have advanced since this snapshot.

The source-only patch is an alternative for applying code fixes without replacing newer data. It targets the base commit above. Do not apply both the full source archive and patch to the same checkout.

```bash
npm ci --ignore-scripts
npm test

# Preview series recovery without saving:
node src/run.mjs --mode=releases --only=bigg-boss --dry --no-link-check --tmdb-limit=0

# Save a targeted recovery locally:
node src/run.mjs --mode=releases --only=bigg-boss --no-link-check

# Retry metadata misses with private environment credentials:
node src/run.mjs --mode=enrich --retry-misses --limit=0 --budget-min=30 --concurrency=4 --report=reports/next-backfill.json
```

Store comma-separated keys in the GitHub Actions **`TMDB_KEYS` secret**, never in source control. Both metadata workflows now expose a **Retry misses** input. `--verify-ids` also includes otherwise complete records and only replaces a suspect ID when a better match is established. `--dry` does not modify vault/state or write an audit report.

The supplied keys have been shared in chat; rotate them after use as a precaution.
