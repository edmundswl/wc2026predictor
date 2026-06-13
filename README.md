# wc2026predictor

## Singapore Pools availability snapshot

Run this from the repo to refresh the Singapore Pools World Cup public listing snapshot:

```sh
node scripts/update-sgpools.mjs
```

The updater writes `data/sgpools-markets.json`. It reads public Singapore Pools pages only; it does not fetch live prices, log in, place bets, or use private account data.
