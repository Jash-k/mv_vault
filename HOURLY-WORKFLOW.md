# Hourly new entries — single-page fast lane

## Delivered and tested

New workflow: `.github/workflows/hourly-new-entries.yml`.
Runner: `src/hourly.mjs`; tested core: `src/hourly-core.mjs`.

The included `data/vault.json` is refreshed: a live first run read 20 listing entries, skipped 15 already-known titles and added 5 titles / 33 confirmed embeds. Catalogue now contains 7,522 records / 22,331 embeds. All 7,517 prior records were verified structurally unchanged, including their links and metadata. Flat/nested series integrity passed. A second live run found all 20 entries known and left vault/index/state/hourly-queue files byte-identical.

The five additions were Enemy of the Smuggler, Aadarsha Kutumbam, Octopus, Garividi Lakshmi and Notebook 90s Kadhal Flashback (source year 2026). Their inclusion and source dates do not independently verify official release dates, original language or TMDB identity. Metadata enrichment remains the separate existing workflows' job.

Evidence: `reports/hourly-first-summary.json`, `hourly-first-run.log`, `hourly-noop-run.log`, `hourly-preservation-audit.json`. All 63 tests passed, including offline CLI file-writing/no-op tests and hourly retry, known-title, mixed-series, pagination-exclusion, budget and preservation regressions (`reports/tests-hourly.log`).

## Schedule and discovery scope

Runs at minute **37 of every UTC hour**, which is minute **07 of every IST hour** (for example 01:07, 02:07 IST). GitHub scheduling is best-effort and may be delayed or skipped; shared writer concurrency can queue/coalesce pending executions. This is not an exact hourly delivery guarantee.

Default discovery URL:

```
https://moviesda36.com/moviesda-tamil-movies-2026/
```

The default year is computed from the current UTC year, so it becomes the 2027 root at UTC New Year. To pin a year or change a future MoviesDa host, set repository variable `HOURLY_LISTING_URL`, or use the manual workflow's `listing_url` input. It must be an HTTPS `/moviesda-tamil-movies-YYYY/` root without query/hash. Invalid or unavailable roots fail visibly; the runner does not silently scan another year or source.

Exactly ONE listing page is requested per run (the shared HTTP helper may retry a failed request). No page-2 pagination, A–Z, isaiDub, separate series listing or other year is discovered by this workflow. All entries on that first page are compared locally: it does not stop at the first known title. Each unknown title may require multiple detail/folder/download/player requests to collect confirmed embeds.

## Behaviour

1. Load the existing catalogue/state and durable `data/hourly.json` pending queue. Refuse to initialize an empty catalogue.
2. Fetch and parse the single listing. Recognize both movies and series.
3. Compare MoviesDa source paths across domain aliases and title/year/type identity against stored records. Skip known titles without requesting their detail pages. Display-text badges are not the matching key.
4. Queue unknown entries, then process due work within a default ten-minute budget and 30-title cap.
5. Follow only the queued titles' detail/episode/download pages to collect confirmed links; determine movie/series from the actual page.
6. Union-upsert confirmed records, rebuilding JSON/index/state. Store source-based Tamil placement for unresolved new records; never invent TMDB IDs or original language.
7. Save each confirmed title and checkpoint the retry queue. Empty/failed titles remain pending, even if they leave page one. Retry backoff starts at 30 minutes and rises to a maximum 24 hours. At an hourly schedule the earliest normal retry is the next run.
8. A newly discovered series whose first walk was incomplete can be revisited via its pending item until complete; only confirmed episodes are retained. This exception does not turn the hourly job into general existing-series refresh.
9. No generic catalogue metadata pass, link-health sweep or existing-title refresh. These remain the existing six-hour/enrichment/historical workflows' responsibility.
10. Commit/push changed `data/` files only. Report JSON is uploaded as an Actions artifact, not committed hourly. Queue-only retry/backoff changes can legitimately create a data commit even when no title was added. A known-only run with no pending changes makes no data commit.

The `empty` count is also included in failed attempts; do not sum those as distinct titles. Reports distinguish pending/incomplete work. Source failure is reported as a failed workflow even when confirmed pending retries were saved and published first.

## Enable on GitHub

1. Upload/commit this repaired repo, including `.github/workflows/hourly-new-entries.yml`, source modules and the actual updated `data/` JSON.
2. Ensure GitHub Actions is enabled and repository policy permits Actions to write contents. Branch protection must permit the workflow's normal data push; the workflow does not bypass branch protection.
3. Scheduled workflows execute from the default branch. You may manually run **Hourly new entries (single MoviesDa page)** first, with publishing enabled.
4. No TMDB key is needed for this hourly crawler. Existing enrichment workflows still need their private TMDB secret.
5. Keep the six-hour workflow enabled for new episodes, updated versions and wider discovery. A first-page-only hourly job can miss titles if more than one page's worth is added between successful runs; broader workflows are the safety net.

The hourly job shares `vault-writer-${repository}` concurrency with the existing workflows and will not cancel a running writer. Local runs must also avoid all concurrent catalogue writers. A local hourly lock and historical-lock check guard obvious conflicts; do not assume the other legacy CLI runners understand the hourly lock.

Workflow duration limit: 20 minutes; crawl budget configurable up to 15 minutes. Manual `publish=false` runs on the temporary Actions runner without pushing data; it is not a local no-write mode. Diagnostics remain in Actions artifacts. A cancelled/killed job may lose the currently uncheckpointed title; already-checkpointed published data remains preserved, but GitHub cannot publish after its runner is forcibly killed.

## Local usage (Node 22+)

```sh
npm ci --ignore-scripts
npm test
npm run hourly
# Optional exact discovery root / smaller test budget:
node src/hourly.mjs --listing-url=https://moviesda36.com/moviesda-tamil-movies-2026/ --budget-min=2 --max-items=5
```

Local runner writes data and reports but never performs git commit/push; publishing belongs to the workflow. Do not remove `data/.hourly.lock` unless no hourly process is active. Locks and private environment files are excluded from the delivery ZIP.

## JaSH automatic updates

Publish the refreshed feed to the configured GitHub location, and use live-feed mode in JaSH:

```env
VAULT_USE_BUNDLED_SNAPSHOT=false
VAULT_SOURCE_URL=https://raw.githubusercontent.com/Jash-k/mv_vault/main/data/vault.json
```

Restart JaSH once after changing environment settings. After that it receives new published data after normal cache refresh, without a JaSH redeployment for each title. With bundled snapshot mode true, workflow feed updates are ignored until replacing/redeploying JaSH's snapshot.

No GitHub repository push, Actions dispatch or production deployment was performed while preparing this ZIP. Uploading this repo and enabling the workflow are still required.
