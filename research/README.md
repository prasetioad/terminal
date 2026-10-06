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
| `momentum.ts` | Trend capture and other families: breakout + chandelier, pullback in uptrend, weekly rotation, the method on 1h. Features: taker-buy flow, volume surge, RS vs BTC, BTC 200D regime, Fear & Greed (alternative.me). Feature diagnostics by bucket, filters, combined portfolios, per-year, ZEC check. |
| `stoch-level.ts` | Stochastic cross level 20 / 30 / 40 / 50: per-trade quality of the extra signals, breadth by level, portfolio grid (level × breadth), per year, 1h. |
| `v1-experiments.ts` | Setup v1 without the 1D bias and with breadth counted over 1–3 bars (v1.2 portfolio rules). |
| `capital-split.ts` | v1.2 + Setup A in one account: shared capital vs a cap on each setup's share of equity. |
| `daily.ts` | The method on daily candles (built from the 4h cache): green dot + Stochastic and green dot alone, no breadth or filter; 4h shown for reference. |
| `stops.ts` | Which entries get stopped out (features, MAE/MFE), and stop / breakeven / entry variants for v1.2 and Setup A in bot-like portfolios; combined. |
| `reversal.ts` | Stopped trades: how far they rose first and when; early exits (stoch/WT cross down, back to entry, half the gain, partial take-profit) per trade and in portfolios. |
| `futures.ts` | Binance USDT-M futures data (funding, 5-minute OI / long-short / taker metrics, perp 4h klines) for the universe, compacted per 4h bar; falls back to dated keys when the bucket listing is throttled. |
| `confluence.ts` | Tahap 7 F2–F4: futures positioning at the entry and while held, terciles with directions fixed in advance, exposure scaling by confluence score, exit warnings. |
| `tp.ts` | Take-profit methods on the bot's entries: chandelier multiples, volume-adaptive trails, volume-climax exits, profit locks, Turtle exit (A); trailing after the first red dot by breadth/volume (v1.2). |
| `carry.ts` | Funding carry (long spot + short perp while funding is high): standalone and as a sleeve. |
| `maximize.ts` | Setup A re-entry, pyramiding, tighter spike trails, and funding carry as a third sleeve, combined with v1.2. |
| `h1.ts` | MaxFlow + Stochastic only on 1h candles (no other filter): variants, break-even cost, portfolios at three cost levels. |
| `intraday-pairs.ts` | 5m klines since 2022 for 30 liquid pairs (intraday research). |
| `intraday.ts` | Sweep & reclaim and session opening-range breakouts on 5m/15m with delta filters, 1R/2R targets, three cost levels. |
| `vwap-breakout.ts` | Gemini's intraday spot strategy (daily VWAP + EMA20 + 20-bar breakout + volume spike, 15m) exactly as its script, its 140-combination grid, screening, gap fills, portfolios. |
| `vwap-breakout-v2.ts` | Gemini's fixes to it: ADX filter, 1h EMA200 trend, breakout-retest with engulfing/pin-bar confirmation, ATR stops (48 combinations). |
| `intraday-edge.ts` | Claude × Gemini round 1 (`Discussion.md`): hour-of-day seasonality, 1h capitulation flushes by market context, intraday day momentum; t-stats per trade and per event (same-hour trades as one event). |
| `momentum-runner.ts` | Gemini's "momentum runner": 24h gainers on 3× volume, chase / VWAP / EMA20 pullback entries, 12h or BE + 3R bracket exits. |
| `funding-basis.ts` | Gemini's post-funding squeeze (negative funding at settlement) and perp-spot basis discount with falling OI, each against a control. |
| `listing.ts` | New Binance spot listings since 2021: drift after the first hour, and Gemini's ORB-4h / hour-2 follow-through / day-1 breakout entries. |
| `preload.ts` | Fill the kline cache for one interval (`npx tsx research/preload.ts 1h`, resumable; the 1h cache is ~1.3 GB). |
| `variants.ts` | Upgrade research for v1.1 (H1–H8: breadth, ranking, sizing, slots, risk cap per bar, exits, BTC regime, stoch-only). Bot-like compounding portfolio marked to market every bar; grid selected on in-sample only. Dataset cached in `research/.cache/variants-dataset.json`. |
| `setup-v1.ts` | Backtest with point-in-time liquidity (trailing 30-day average daily quote volume at the signal), breadth (pairs signalling on the same bar), in-/out-of-sample split at 2024-07-01, per-year results, listed vs delisted, bootstrap 95% CI and a bot-like portfolio (most liquid first, ≤ 15 open, 1% risk). |

Methodology rules (docs/ROADMAP.md §2): hypotheses and parameters fixed before looking at results;
thresholds chosen on in-sample only; costs always included; findings reported as they are.

The first full run downloads ~650 pairs × 4h since 2021 (~15 minutes); later runs use the cache.
