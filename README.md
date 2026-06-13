# wc2026predictor

## Singapore Pools availability snapshot

Run this from the repo to refresh the Singapore Pools World Cup public listing snapshot:

```sh
node scripts/update-sgpools.mjs
```

The updater writes `data/sgpools-markets.json`. It reads public Singapore Pools pages only; it does not fetch live prices, log in, place bets, or use private account data.

## World Cup results snapshot

Run this from the repo to refresh played World Cup matches:

```sh
node scripts/update-results.mjs
```

The updater reads the public ESPN FIFA World Cup scoreboard, matches completed games to `data/schedule.json`, and writes `data/results.json`. Once a match appears in `data/results.json`, the app treats it as played and removes it from upcoming prediction/watchlist sections.

## GitHub Actions automation

The `.github/workflows/update-data.yml` workflow runs these updates on GitHub's servers:

- played results every hour at 15 minutes past the hour
- Singapore Pools public listings daily at 08:00 Singapore time

It commits changed JSON files back to `main`, so GitHub Pages redeploys without your Mac staying on.
