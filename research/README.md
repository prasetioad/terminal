# Research Lab

Reproducible research behind the setups (results and decisions: [docs/ROADMAP.md](../docs/ROADMAP.md)).
Every script runs the **same engine** the app, the scanner and the bot use (`lib/setups/`).

```bash
npm run research:setup-v1                 # Setup v1 on the survivorship-free universe (stoch "either")
npx tsx research/setup-v1.ts --stoch 5,3,3
```

| File | What it does |
|---|---|
| `data.ts` | Binance spot klines from the public archive (data.binance.vision, **delisted symbols included**) topped up from the API; cached in `research/.cache` (git-ignored). A series is never cached partially. Archive timestamps (ms before 2025, µs after) are normalized; a ticker reused by a new coin (LUNA → LUNA 2.0) is split at the data gap. |
| `universe.ts` | Every spot USDT pair that ever traded, minus stablecoins, fiat, wrapped/pegged assets and leveraged tokens. |
| `setup-v1.ts` | Backtest with point-in-time liquidity (trailing 30-day average daily quote volume at the signal), breadth (pairs signalling on the same bar), in-/out-of-sample split at 2024-07-01, per-year results, listed vs delisted, bootstrap 95% CI and a bot-like portfolio (most liquid first, ≤ 15 open, 1% risk). |

Methodology rules (docs/ROADMAP.md §2): hypotheses and parameters fixed before looking at results;
thresholds chosen on in-sample only; costs always included; findings reported as they are.

The first full run downloads ~650 pairs × 4h since 2021 (~15 minutes); later runs use the cache.
