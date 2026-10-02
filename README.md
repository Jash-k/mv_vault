# mv_vault · two-workflow edition (v3.0.0)

A staged, resumable update pipeline for the existing Tamil movie/series JSON vault.

**Two production workflows, one shared publisher:**

| Workflow | Discovery | Schedule (UTC / IST) | Default budget |
|---|---|---|---|
| `new-releases.yml` | Current-year Tamil movies + latest Tamil series | 00:17, 06:17, 12:17, 18:17 UTC / 05:47, 11:47, 17:47, 23:47 IST | 20 min, 100 items |
| `archive-az.yml` | A–Z Tamil movie listing with persistent page/item queue | 19:43 UTC / 01:13 IST next day | 40 min, 150 items |

A separate **read-only CI workflow** runs offline regression tests on code changes and PRs. It does not scrape or publish.

## Upgrade first — important

See [DEPLOYMENT.md](DEPLOYMENT.md) for the complete checklist.

1. Back up the repository and current `data/` before upgrading.
2. **Delete the old `.github/workflows/vault.yml`.** Extracting a ZIP over a checkout does not delete obsolete files. Leaving the old scheduled workflow active defeats the shared-writer safety.
3. Copy the new source/config/scripts/tests/workflows. Preserve your newest production data, especially if it has advanced since this ZIP's snapshot.
4. Add the supplied `data/known-drift.json` and `data/aliases.json` if absent. The drift file records the supplied snapshot's legacy exceptions; it is **not a claim that those metadata matches are correct**. New exceptions need review.
5. Install **Node 22**, then `npm ci --ignore-scripts` and `npm run check`.
6. Commit the upgrade to the default branch. Run both workflows manually with **dry=true**, small item limits and a short budget. Inspect artifacts before enabling publishing.

Use only with sources/content you are permitted to access. Respect source terms and rate limits. The scraper does not bypass login, DRM, CAPTCHAs or anti-bot challenges; unrecognized/error pages are treated as uncertain and reported.

## What the release workflow does

- Visits `/tamil-2026-movies/` in 2026; year rollover is automatic. Set `releaseYear: 2026` to pin it instead.
- During January/February, also checks the previous year by default.
- Refreshes the first year-listing page every run and traverses deeper pages using its own persisted cursor.
- Visits the latest three series-listing pages using `?get-page=N`.
- Keeps existing series queued after they leave the latest listing; periodically re-walks them even when old links remain live. This includes all existing series conservatively because the catalogue has no trustworthy completed/ongoing flag.
- Rechecks current-year stored movies for better qualities or replacement sources.
- Separately schedules new arrivals, series, retries and refreshes using weighted round-robin. A large retry backlog cannot consume every slot.
- Retains every configured alternate path instead of deduplicating all aliases down to one page.

The release workflow does **not** scan A–Z, historical year folders, or the sitemap. Numeric-title coverage relies on the current-year listing or a manually supplied queue; it is not a full historical numeric-title crawler.

## How A–Z resumes

`data/archive-state.json` holds:

- the current cycle, letter and next listing page;
- fingerprints of previously seen pages for that letter;
- a persistent per-path job queue, including pending and failed items;
- next-attempt timestamps, identity locks and attempt history.

Discovery stores page items **and** its next cursor in the same candidate checkpoint. A network error or ambiguous empty document never marks a letter complete. Explicit end-of-listing responses or a repeated page fingerprint end that letter. A page that starts returning a challenge stops progress for review rather than being mistaken for completion.

When a soft budget expires, unstarted jobs stay pending and the complete validated generation is published. The next run resumes from that published cursor/queue. If GitHub hard-kills the job or publication fails, it resumes from the **last published** generation; some work may repeat, but unpublished records are never marked permanently done.

After Z, discovery pauses seven days and begins another reconciliation cycle. Successfully walked archive records normally become due again after 90 days. Listing positions can shift as upstream titles are added, so the periodic rescan is intentional.

## Publication safety

```text
Load committed baseline
  → clone data into .runs/<mode>/candidate/
  → crawl + save candidate checkpoints
  → regenerate vault/stats/index/manifest + matching queues
  → validate against the previous generation
  → hash approved files
  → publish one data-only Git commit
  → upload diagnostics
  → explicitly report degraded health as a failed run
```

- Both production workflows share the same `vault-writer-<repository>` concurrency group and never cancel an in-progress writer.
- GitHub concurrency is not a FIFO priority queue; pending runs may be replaced. Queues persist in Git, so a missed invocation does not discard published progress.
- Git publication checks the original source SHA. If a manual push has changed the branch, it **fails safely** and asks for a rerun. There is no force push, soft-reset recovery, or stale-index source overwrite.
- A normal push race also fails; it is not silently resolved by overwriting another generation.
- Rejected candidates do not publish their successful-state markers separately from the rejected vault.
- Existing IDs cannot disappear, drift/shared-embed exceptions cannot expand silently, and the browse index is compared by content, not merely length.
- Missing/corrupt required JSON fails closed.
- A source-degraded run may publish structurally valid progress, but its final health step fails visibly. An interrupted/fatal or invalid candidate is not approved.
- Artifacts contain candidate data and diagnostics for 14 days. They do not contain TMDB credentials; never manually paste secrets into error messages or configuration.

Git commits make publication coherent in the repository. Consumers fetching multiple raw files should use **the same commit SHA**, not unrelated cached `main` URLs, to avoid mixed generations.

## Retry and health policy

- Genuine empty page: 12 hours → 1 day → 3 days → 7 days → 30 days, then monthly. No silently skipped final rung.
- Read failure: bounded exponential cooldown up to 24 hours. No automatic permanent death after five outages.
- Partial walk: retry after six hours in the new job scheduler.
- Canary uncertainty: keep no-link results unknown instead of escalating a global outage into permanent item deletion.
- Known-record canaries check the walker before normal work. Default selection is recent stored movies/series; configure stable known-good IDs in `canaryRecordIds` after the first live review.
- Readable old pages may legitimately be empty; the proportion of empty archive retries is not itself proof of a parser failure.
- HTTP has finite request/time/body limits, per-host pacing, Retry-After handling and approved-host redirect checks. Hard 404s do not park an otherwise healthy host.

`retryAfter` means eligible after that time, not that a workflow launches immediately then. With six-hour schedules, actual retries happen at the next available scheduled/manual run.

## Posters, metadata and link checks

The release job spends remaining budget on maintenance. Archive runs focus on archive work.

- **Posters:** oldest-due-first; absent results get a seven-day cooldown, uncertain results six hours. Missing artwork at the front of the vault cannot starve later records.
- **TMDB:** optional key; bounded exact title/year matching, separate movie/TV endpoints, ambiguous results left unchanged. TV records with old unknown-type TMDB IDs are searched again rather than blindly queried as movies. Rate-limit responses pause requests rather than rotating keys to evade limits.
- **Liveness:** 100 least-recently-checked records per release run by default. A recognized player source is required for `live`; a player HTML check is not a guarantee that the media itself plays.
- **Deletion is conservative:** `autoPruneDeadLinks` defaults to **false**. Dead links queue repairs; they are not automatically removed. If explicitly enabled, pruning requires two dead observations at least six hours apart, never empties a record and rejects >5% removal in one candidate. Review before enabling it.
- Repair/ingest/enrich commands all use staging. Automatic junk-ID renaming is deliberately removed to preserve deep links.

## Configuration

Edit `config/workflows.json`; numeric values are range-validated.

Useful defaults: concurrency 4, maxRequests 4000 per job, release listing pages 8 per run, latest-series pages 3, archive listing pages 10 per run, series refresh 6h, recent movie refresh 24h. These are safety starting points, not live benchmarks.

`config/page-aliases.json` is for reviewed path → permanent-ID mappings. Alternative paths are not proof of duplicate identity. Unknown collisions are quarantined in the progress file and reported as degraded, while other pages/items continue. They are never silently merged.

Environment variables:

- `TMDB_KEYS` or `TMDB_API_KEY`: optional, never committed.
- `VAULT_TIMEOUT_MS` (default 15 seconds in shared fetch).
- `VAULT_MIN_INTERVAL_MS` (default 120 ms between request starts per host).
- `VAULT_ALLOWED_HOSTS`: comma-separated approved hosts. Add a newly reviewed upstream host explicitly after a domain migration; redirects to unknown hosts fail closed.
- `VAULT_BUDGET_MIN` and `VAULT_MAX_ITEMS`: optional bounded job overrides.

The public link/source format remains compatible: movies omit `kind`, series retain `seasons[]` and flattened `embeds[]`, IDs remain stable. `tmdbType` is an optional additive field on newly enriched records.

## Local commands

```bash
npm ci --ignore-scripts
npm run check                          # syntax, tests, existing vault verification
npm run releases -- --dry --max-items=5 --budget-min=2
npm run archive -- --dry --max-items=5 --budget-min=2
npm run releases -- --apply            # validate and apply locally; no Git push
npm run archive -- --apply
npm run posters -- --apply
npm run enrich -- --apply              # optional TMDB_API_KEY/TMDB_KEYS required
npm run liveness -- --apply
npm run ingest -- --queue=/absolute/path/incoming.json --apply
```

Without `--apply`, local commands prepare a candidate only. `--dry` leaves tracked `data/` unchanged but intentionally writes scratch logs/candidate files under ignored `.runs/`. `--prepare` is the CI mode: safe degraded candidates can progress to publishing before final status is evaluated.

Read live local logs with `tail -f .runs/archive/run.log` (or `.runs/releases/run.log`).

Legacy `--incremental`, `--sweep`, `--letters=a-z`, and `--max-movies` have explicit compatibility mappings. Other removed legacy flags fail with an explanation; they are not silently ignored. `--sweep` now means A–Z reconciliation, not the old nine-section crawler.

## Data and recovery files

| File | Role |
|---|---|
| `vault.json` | Existing consumer catalogue |
| `state.json` | Compatible per-page result bookkeeping |
| `releases-state.json` | Release discovery cursors and refresh/retry queue; created on first successful run |
| `archive-state.json` | A–Z cursor and pending/retry queue; created on first successful run |
| `maintenance-state.json` | Poster/metadata cooldowns and link observations |
| `liveness.json` | Per-record link-check counts and timestamps |
| `last-run.json` | Most recently published run, with run ID and source SHA |
| `index.json`, `manifest.json`, `vault-stats.json` | Rebuilt consumer-derived files |
| `known-drift.json`, `aliases.json` | Reviewed/manual guards, never rewritten by the bot |

A failed candidate remains in `.runs/<mode>/` and in the workflow artifact when upload succeeds. Do not copy its state alone into production. For local interruption during directory replacement, `.data-backup` is preserved; restore it before retrying. A stale `.runs/LOCK` must be removed only after confirming no job is running.

## Validation and limitations

See `TEST-RESULTS.md` and `KNOWN-LIMITATIONS.md`. The package is validated with offline fixtures, temporary Git remotes, and the supplied vault snapshot. It is **not certified against the current live site**, account secrets, branch protections, or full video playback. Review the first dry-run artifacts. No scraper can promise zero future errors when a third party changes its pages or domains.
