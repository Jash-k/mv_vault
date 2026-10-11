# Durable metadata enrichment

## Why a poster can still be Unverified

Artwork is optional display metadata, not evidence of a title's original language.
The application requires a corroborated identity and original language for its
Tamil/Dubbed classification. Tamil audio on a source page is not original-language
evidence. A missing rating (including a legitimate zero-vote rating) is not an
identity failure.

Previously, daily enrichment only considered touched records, competed with the
crawl deadline, and legacy miss markers could indefinitely exclude records.
Metadata-only runs also stopped after five individual incomplete lookups. The
IsaiDub workflow did not receive the TMDB secret. These are pipeline limitations;
without historical per-title logs they do not prove why each individual title
was missed.

## New scheduling

- Releases, A–Z and IsaiDub run the same vault-wide worker after crawling, with
  a separate five-minute budget and up to 150 attempts. Crawl exhaustion or a
  caught listing error does not prevent this phase.
- Enrich and TMDB backfill use the same durable queue. Enrich also runs at
  03:47 and 15:47 UTC (09:17 and 21:17 IST); Actions scheduling may be delayed.
- Weighted lanes give three slots to new identity work, three to the existing
  backlog and one to optional metadata, redistributing slots when lanes empty.
- `data/state.json` stores versioned fingerprints, actual attempts, outcomes,
  reasons and next retry times under `metadata`. Old `tmdbMiss` entries no
  longer block scheduling. New identity/source evidence invalidates old attempts;
  adding episodes alone does not.
- Unresolved retries: 6h, 1d, 3d, then 7d. Unavailable retries: 1h, 6h, then 1d.
  Review retries: 7d, then 30d. Successfully identified records still missing
  optional metadata retry after 30d. Complete records need no periodic work.
- Individual failures do not stop the queue. A real key-wide outage or the
  metadata deadline does. Lookups are bounded to 45 seconds and 120 TMDB
  requests per record; batches use up to eight workers (default four).
- State/data and diagnostics checkpoint approximately every 20 attempts or
  15 seconds, and at completion. A hard termination can lose the latest batch.
  All writing workflows retain the shared concurrency group.

## Matching safeguards

Source credits are captured during scraping and can be fetched separately for
legacy records. Source pages are metadata only: the worker never walks players.
A poster, Tamil audio label or a site category cannot establish original language.
Credit fallback requires independent people, protects sequel numbers and rejects
ambiguous competing titles. TV details include aggregate credits. Series playback
structure is never converted into a film because of a conflicting source template.

Year-scoped TV recovery uses TMDB's episode-inclusive `year`, not
`first_air_date_year`. Even corroborated scoped results are **review suggestions**,
not automatic assignments: a truncated broad search cannot rule out all rivals.
The report includes suggested identity and evidence. A reviewed override can
promote a verified identity. Existing metadata is preserved on unresolved or
conflicting matches; this patch does not promise every Unverified row will clear.

## Operations

Use Node 22, run `npm ci --ignore-scripts`, and provide `TMDB_KEYS` (or
`TMDB_API_KEY`) securely. All scraping workflows now pass the existing repository
secret; the patch does not create or change a secret.

```sh
# Read-only checks; dry mode writes neither state/data nor a report.
node src/run.mjs --mode=enrich --dry --limit=20 --budget-min=2

# Local metadata-only pass; no push without --commit.
node src/run.mjs --mode=enrich --budget-min=20 --report=reports/metadata.json

# Target one title and force its pending attempt before backoff expires.
node src/run.mjs --mode=enrich --only="title here" --retry-misses --limit=1
```

Metadata-only `--limit=0` means no count limit (the time budget still applies).
Daily `--tmdb-limit=0` or `--metadata-budget-min=0` disables daily enrichment.
`--verify-ids` explicitly rechecks stored identities and bypasses their retry
schedule; do not enable it routinely. `--stale-days=N` forces otherwise eligible
attempts older than N days. Without these flags, backoff is automatic.

The JSON report contains `summary` and `records`, replacing the older bare audit
array. Outcomes include matched, unresolved, review, unavailable and pending;
counts distinguish actual attempts, changed rows and selected rows not reached.
Pending identity rows outside this run's selected slice are also included.
Workflow artifacts retain reports for 14 days, including after failed runs when
an artifact exists. Dry runs intentionally produce no artifact. Missing keys
are explicitly reported, not recorded as completed title misses.

## Reviewed overrides

`metadata-overrides.json` is initially empty. Keys must be existing vault record
IDs. Each mapping requires a positive integer `tmdbId`, `tmdbType` (`movie` or
`tv`), canonical `expectedTitle`, a nonempty `reason`, and an `evidenceUrls` array
of HTTPS links. Review those sources manually: URL validation is not factual
verification. The lookup validates the canonical title and rejects media-type
conflicts. Never invent mappings merely to reduce the Unverified count.

## Validation and rollout

47 automated tests pass on Node 22, using mocked metadata/source responses.
Coverage includes repeated backlog progress, finite retries, optional zero
ratings, individual-failure isolation, bounded requests, identity conflicts,
scoped-search review, workflow wiring and metadata after crawl failure.
No authenticated live TMDB validation was possible in the development workspace.
No production vault/state files are changed by this source patch.

After applying, first run Enrich dry with a small limit and inspect its logs.
Then run a bounded normal Enrich and inspect the metadata artifact and data diff.
The scheduled/daily worker will continue due backlog automatically. Monitor
unavailable reasons separately from genuine unresolved/review cases. Approval
and deployment are separate from applying this local patch; workflows can
commit data on their configured scheduled runs once deployed to the repository.
