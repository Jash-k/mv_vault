# Catalogue recovery and deployment

## Delivered snapshot

- 7,517 records: 6,897 movies and 620 series (baseline: 7,502 / 6,889 / 613).
- 22,298 embeds, up from 22,134; 6,640 episode slots, up from 6,500.
- All 7,502 baseline IDs and all 22,134 baseline embeds retained. No flat/nested series integrity failures.
- Missing TMDB IDs: 1,748 → 981; missing posters: 376 → 294.
- Unknown/conflicting-language classifications: 1,747 → 980. These remain honestly unverified, not cosmetically relabelled.
- Bigg Boss 2026 and the season-10 source record now each contain 77 confirmed episodes; separate source records are retained rather than destructively deduplicated.

The included `data/vault.json` is the actual refreshed feed. `data/index.json`, `data/state.json`, and `data/historic.json` accompany it. Reports document integrity, live metadata checks and unresolved titles.

## Coverage is not complete

The historical discovery pass visited both existing sources, including Tamil and dubbed movies/series, and queued 8,753 unique source paths across 57 completed listing tasks. This is discovery within the configured roots, not proof that every upstream title exists in the queue. At its checkpoint, outcomes were 6,765 stored movies skipped, 420 pages yielding no recoverable embeds, 55 complete walks, 2 incomplete walks, 3 failures and 1,508 queued paths not attempted. Some source pages are empty, removed, blocked or temporarily unavailable. Stored movies were not exhaustively replay-tested. Source dates/claims are not independent release-date verification.

The metadata pass was bounded: `reports/metadata-refresh.json` shows attempted/matched/unresolved totals. A second independent live check recovered regression-lost published IDs only with exact title/year corroboration; the conservative review failures are retained in `reports/recovered-published-metadata.json`. Refresh counters from different passes overlap and must not be summed as unique records. Final catalogue counts are in `reports/recovery-summary.json`.

## Repairs

- Restored coherent crawl/enrichment behaviour; transient player errors no longer delete valid links.
- Follow actual declared pagination, including isaiDub numeric paths; preserve episode identity rather than invent sequence numbers.
- Union-upsert confirmed links; retain confirmed partial MoviesDa series results when a budget expires.
- Historical queue/checkpoints, current-release-first recovery, configurable source host and explicit incomplete outcomes.
- Evidence-based metadata, regional-language ambiguity protection, reviewed overrides and isolated metadata merge without overwriting crawl additions.
- Updated vulnerable dependency; production dependency audit reports zero vulnerabilities at delivery.

## Continue locally (Node 22+)

```sh
npm ci --ignore-scripts
npm test
# Supply private TMDB_KEYS via your own environment, never committed files.
node src/historic.mjs --budget-min=90 --metadata-budget-min=20 --concurrency=3
```

Rerun to resume pending/incomplete/failed paths. Empty source pages need upstream recovery before usable embeds can be recovered. To start a new discovery pass from the roots rather than resume completed listing cursors, add `--new-pass`; this resets the historical queue/checkpoint, not the preserved catalogue. Budget caps: crawl 0–120 minutes, metadata 0–40 minutes. Never run two writers against the same data files.

The manual GitHub `Historical catalogue and episode recovery` workflow tests, crawls, then **commits/pushes** refreshed data if you choose to run it in your repository. Configure private repository secret `TMDB_KEYS` (or `TMDB_API_KEY`), and optional variable `MOVIESDA_HOST`. No workflow was dispatched, repository pushed or production deployed during this repair.

## Validation

53/53 tests pass on Node 22; dependency audit and final integrity reports included. Network checks establish source/player reachability only, not successful playback of every video. Metadata verification does not establish copyright authorization.

No credentials, dependency folders, Git history or active lock files are included in the delivery archive.
