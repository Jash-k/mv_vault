# Validation results — v3.0.0

Package prepared on 2026-10-02 from original repository commit `78a6894ca6fb599a95ad15f74c5031948c3e9f89`.

## Executed checks

| Check | Result |
|---|---|
| Lockfile install, lifecycle scripts disabled | PASS; 23 packages installed, npm reported 0 known vulnerabilities at check time |
| Node syntax validation for source/scripts/tests | PASS |
| Offline regression suite on Node **22.23.3** | **52 passed, 0 failed, 0 skipped** |
| Existing vault structural/derived integrity verification | PASS |
| GitHub Actions lint, actionlint **1.7.12** | PASS; no findings |
| Full staged archive run with intercepted fixture-only fetch | PASS |
| Dry-run comparison of every tracked data JSON hash | PASS; unchanged |
| Local validated whole-generation apply | PASS; resulting vault verification passed |
| Temporary local Git-remote normal data-only publication | PASS |
| Concurrent human source-code push conflict simulation | PASS; publisher refused publication and preserved human commit |
| Candidate changed after approval / dry candidate publication | Both correctly rejected |
| Existing record removal, orphan successful job and stale index | Correctly rejected |

A clean ZIP extraction was independently checked using Node 22.23.3 for both `npm ci --ignore-scripts` and `npm run check`: installation passed, all 52 tests passed again, and vault verification passed. Packaged workflow files also passed actionlint when supplied explicitly (the ZIP intentionally has no Git metadata). Internal SHA-256 file checks and ZIP CRC validation passed. GitHub workflows use Node 22; use it for local deployment too.

## Tested behavior

- Every retry rung, including the final 30-day retry; no permanent death from repeated network failure; legacy dead-item probation.
- Stored failed-record recovery and persistent partial rechecks.
- Single-quoted listing links, generic labels, challenge/ambiguous-empty rejection and external-link exclusion.
- All 2,864 stored page URL shapes remain recognizable by the listing adapter, including legacy numbered movie and moviesda suffixes.
- Identity-locked existing records, explicit aliases, collision quarantine and skip paths.
- Weighted scheduling across fresh arrivals, series, retries and refreshes.
- Failed archive pages do not advance; successful page discovery retains pending jobs and the next cursor; cycle completion and deadline stops.
- Current-year transition and previous-year grace period; stored series remain tracked after leaving latest listings.
- Release discovery is restricted to configured current-year/series sources, not A–Z or sitemap.
- Successful series maintenance result handling and tree/flat union consistency.
- Unrelated same-title/same-episode-number series are not merged without shared source evidence.
- Empty records cannot be produced by pruning.
- Queue success and corresponding vault record are saved together; uncertain source health does not create terminal item state.
- Movie versus TV metadata matching, wrong-year/fuzzy/ambiguous-match rejection.
- Poster absolute URL normalization, soft-404 classification, negative caching and starvation prevention.
- Movie and series hop traversal with synthetic HTML fixtures.
- Retry-After parsing, hard-404 circuit-breaker behavior, approved-host redirect checks, request/deadline limits.
- Link liveness distinguishes expected player structure, empty bodies, challenge documents and transport failures.

## Supplied data snapshot

- 2,864 records: 2,806 movies and 58 series.
- 8,174 embeds; 665 episodes.
- 1,179 legacy empty pages in state.
- 142 legacy ID drift exceptions and one shared-embed group are recorded as compatibility debt, not certified metadata correctness.
- Original `vault.json` SHA-256 remains `361230656115…` (full hash available in `data/manifest.json`). Production catalogue content was not replaced or scraped during package preparation.

## Not tested against the user's live environment

No production crawl, TMDB request using a real key, authenticated GitHub workflow execution, branch-protection change, or actual video playback was performed. The fixtures prove the represented code paths, not every possible upstream HTML variation. See DEPLOYMENT.md for the required live dry-run smoke checks and KNOWN-LIMITATIONS.md for remaining operational risks.

A passing suite is evidence of tested behavior, not a guarantee of zero future defects.
