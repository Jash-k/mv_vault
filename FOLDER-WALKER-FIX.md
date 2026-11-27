# A–Z empty-result folder traversal repair

## What changed

`walkMovie()` now searches for download links at every visited folder level rather than assuming a fixed Title → Group → Resolution → Download layout. This supports both direct downloads in the first group and extra Original folders before quality folders.

Traversal is limited to same-origin folders, at most 16 folder pages including the item, depth 5, eight download slug pages and ten ID confirmations. It deduplicates visited URLs, rejects navigation/external/sample/trailer links, carries quality labels, prefers 1080p/720p where available, and retains matching-ID confirmation. Deadlines are checked before subsequent stages; already in-flight requests retain their existing HTTP timeouts.

Failed folder/download requests, confirmation transport failures and traversal truncation mark the result incomplete. Existing pipeline state already retries incomplete walks rather than trusting their seven-day empty cooldown. The log now says `no confirmed embeds found` or `incomplete walk · retry required` instead of claiming nothing has been uploaded. WALK_VERSION is now 4, allowing old empty verdicts to be retried without deleting state. The version is shared with series, so some stored series may receive a one-time refresh following the upgrade.

## Real read-only verification

| Title | Before | After |
|---|---|---|
| Appatha | 3 requests, 0 embeds | 9 requests, 1 confirmed embed |
| Anel Meley Panithuli | 3 requests, 0 embeds | 9 requests, 1 confirmed embed |
| Aaradi Bullet | 2 requests, 0 embeds | 4 requests, 1 confirmed embed |

All three after-fix walks completed without an incomplete flag. Confirmation means the source confirmation page referenced its own matching embed ID; this is not certification of video playback.

71 tests passed, including new tests for deeper/shorter layouts, item-level links, loops/navigation/external rejection, samples, deadlines, depth truncation, failed folder/confirmation requests and genuinely empty templates. An older movie fixture used the word Sample as a fake movie name: it was renamed Feature so it tests normal extraction independently of the new sample-file exclusion. The pipeline state fixture now uses WALK_VERSION rather than a hardcoded version.

## Apply: recommended for your current GitHub repository

Your reported remote catalogue has 7,526 records, newer than the local ZIP's 7,522. **Use the incremental patch or changed-files ZIP to preserve your latest data and cursor.** This fix does not require replacing any data JSON.

Back up/commit your working changes. From the mv_vault repository root:

```sh
git apply --check /path/to/mv_vault-folder-walker-fix.patch
git apply /path/to/mv_vault-folder-walker-fix.patch
npm ci --ignore-scripts
npm test
```

Use Node.js 22 or newer. If patch check fails because your code differs, stop and merge carefully rather than forcing it. The changed-files ZIP is an alternative for uploading the repaired source and tests while retaining your existing `data/` directory. Do not apply both methods twice.

Commit and push the repaired files to GitHub. Existing workflows automatically use the new scraper after checkout. No new workflow/token/environment setting is required for this repair.

## Recovery run after publishing

In GitHub Actions → A–Z archive → Run workflow:

- `sweep_empty`: true
- `budget_min`: 15
- `max_items`: 20 (optional limit for the first verification)
- `commit`: true
- `dry`: false

Verify the job log shows recovered embeds and its data commit is published. Then run another sweep with a larger budget if appropriate. Existing records/confirmed links are merged rather than resetting the catalogue. Do not delete state.json, vault.json or az.json. The recovery sweep leaves the normal A–Z cursor unchanged.

Full updated repo ZIP is also supplied as a source reference, but its bundled data is the earlier local 7,522-record snapshot. Do not overwrite your newer remote data with it.

No remote dispatch, data publication, commit or push was performed during this repair. Live checks were read-only and local data files were preserved.
