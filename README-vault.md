# moviesda-vault

Historic vault of **durable onestream embed links** for Tamil movies — one-time(ish)
scrape of the full moviesda A–Z archive. Built to power a click-and-play
"Vault" catalog in JaSH ViBeS: stored links here never rot (unlike direct MP4
tokens, which die within hours), so the app can play them straight from the
JSON with zero server resolution.

**Independent by design** — this repo does not touch [Jash-k/mv_scrapper](https://github.com/Jash-k/mv_scrapper)
or any of its workflows.

## What it collects

Per movie:

```json
{
  "id": "raayan-2024",
  "title": "Raayan",
  "year": 2024,
  "pageUrl": "https://moviesda34.com/raayan-2024-tamil-movie/",
  "embeds": [
    { "quality": "1080p", "url": "https://play.onestream.today/stream/page/101977" },
    { "quality": "720p",  "url": "https://play.onestream.today/stream/page/101973" }
  ],
  "poster": "https://image.tmdb.org/t/p/w500/…",
  "rating": 7.1,
  "tmdbId": 1234567,
  "imdbId": "tt31905828"
}
```

- **Quality policy (locked):** store 1080p + 720p embeds; 360p/other rips only
  when a movie has neither.
- Movies only — web series entries are filtered out at the listing stage.
- `pageUrl` is kept as a permanent anchor: even if an onestream ID dies one
  day, a fresh walk can be re-run from it.

## Files

| Path | Purpose |
|---|---|
| `data/vault.json` | **The deliverable** — the catalog consumed by the app |
| `data/vault-stats.json` | Counters: movies, links, coverage, last update |
| `data/state.json` | Resume state — every processed item URL (never re-walked) |

## How to run (GitHub Actions)

1. Create the repo under your account and upload these files
2. **Settings → Secrets → Actions → new secret:** `TMDB_KEYS`
   (comma-separated TMDB v3 keys — they rotate automatically on
   exhaustion/429; omit for poster-less data)
3. **Actions → Vault Historic Scrape → Run workflow** with inputs:
   - `letters` — e.g. `a-c` (a range) or `a,d,h` (pick list)
   - `max_pages` — cap per letter (`0` = whole letter)
   - `max_movies` — this run's cap (default 150)
   - `budget_min` — soft stop before GitHub's 6h job cap (default 330)
4. When the run finishes, it **commits its own progress**. Dispatch again
   (same or next letter range) — it resumes exactly where it stopped.

### Coverage math (rule of thumb)

~20 titles per listing page, thousands of titles across A–Z, roughly
25–35s per movie. Full archive ≈ 10–14 runs of 150 movies. You can run
one range per day or batch several — `vault-stats.json` shows progress.

## Local CLI

```bash
npm install
TMDB_KEYS=k1,k2 node src/cli.js --letters=r --max-pages=1 --max-movies=4
```

## App wiring (JaSH ViBeS v10.8.0)

Point the app at the raw file — everything else is automatic:

```
VAULT_JSON_URL=https://raw.githubusercontent.com/<you>/moviesda-vault/main/data/vault.json
```

The app caches it for 30 minutes and renders the Vault rail on the home page
plus the full `/vault` browse page. Vault playback plays stored onestream
embeds directly — silent, instant, no resolve chain.
