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
