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
| `support-reclaim.ts` | Gemini's "professional" support bounce on 1h: sweep & reclaim of the 48-bar low, stop under the wick, target the 48-bar high, with no / ADX < 25 / above-daily-EMA200 regime; net at spot and futures-maker costs. |
| `value-area.ts` | Value-area confirmation trades (owner, after Fabio Valentini): VAH breakout-retest-hold and VAL failed breakdown → POC, with volume / MaxFlow variants; swing (1h, 30-day profile) and intraday (5m, previous-day profile), profiles from `lib/profile.ts`. |
| `auction.ts` | Auction-market trades at the previous day's value area in both directions (continuation / failed breakout → POC, long and short), refined by day context, taker aggression and the NY session; Dalton's 80% rule; edge behaviour statistics; futures costs. |
| `aggtrades.ts` | Binance spot aggTrades (every trade with its aggressor) for 5 pairs × 12 months → 1-minute footprint bars (delta, big trades, aggression at the bar's low/high) in `.cache/aggtrades`; raw zips kept in `.cache/aggtrades-raw` (~13 GB). |
| `footprint.ts` | The auction trades of `auction.ts` confirmed by real order flow (initiative for continuation, absorption for reversion), on 5m and 1m; what the retest bar's delta alone predicts. |
| `auction-htf.ts` | Value area from a higher timeframe, entries on a lower one (1h profile → 15m, 4h profile → 1h), both directions, with context / taker-aggression variants and spot / futures costs. |
| `auction-refine.ts` | Owner's refinements on four timeframes, stacked: TP 2R · stop past the heaviest volume node · entry after three bars of taker flow the trade's way. Writes the trades to `.cache/auction-refine-trades.json`. |
| `auction-short.ts` | Robustness of the 4h→1h VAL-breakdown short: per R, perpetual availability, funding, per year, coin concentration, delisted coins, a 1%-risk portfolio. |
| `weekly.ts` | The owner's method on weekly candles (MaxFlow green dot + stochastic, red-dot exit), with weekly bars since 2017 from the API and from the 4h cache for delisted pairs; open trades marked at the last close. |
| `audit.ts` | Bias audit of the bot's setups with the bot's engines: 4h bars shifted by 1–3 hours, other timeframes as-is, costs 0.1/0.2/0.3%, breadth / RS / volume sensitivity, per year. |
| `audit-tf.ts` | The timeframe test made fair: v1.2 with its bias at 6× the chart, Setup A with its windows in days and ATR multiples scaled by √(4h ÷ chart); engine copies checked identical on 4h. |
| `payoff.ts` | Risk/reward of the bot's setups as traded: win rate, average win/loss, payoff, expectancy in % and R, the best 10%'s share of profit, the longest losing run. |
| `stop-entry.ts` | Support trades with the entry at the classic trade's stop (buy the stop sweep), against buying the support; limit fills, 1h / 4h / 1D, per R and per year. |
| `sweep-stats.ts` | Anatomy of support breaks: bounce rate, sweep depth before the bounce (ATR and %), classic-stop hunts, P(bounce | depth), how many reach the resistance. |
| `usdt-dominance.ts` | USDT dominance (proxy: USDT ÷ BTC+ETH market cap, USDT supply from DefiLlama): same-day link to the universe, whether it leads, and regime filters on the bot's portfolio. |
| `usdt-maxflow.ts` | MaxFlow+ dots on USDT-dominance proxy candles (4h, 1D; with and without bias): what BTC and the universe do over the next 1–14 days, and the bot gated by them. |
| `daily-movers.ts` | Picking tomorrow's +5–15% coins at the daily close: base rate and five screens (breakout+volume, top gainers, market-wide capitulation, squeeze, RS leaders), next-day distribution, a 2×ATR trail, and a daily book. |
| `setup-c.ts` | "Setup C", daily market-wide capitulation: a grid of drop × breadth × exit, day boundaries shifted by 4–20h, and the combined portfolio with Setup A (vs v1.2). |
| `controls.ts` | Harness controls: a look-ahead rule (must win), random entries with Setup A's and v1.2's exits (must not), and public rules (BTC above its 50-day average, buy and hold, weekly cross-sectional momentum). |
| `anatomy.ts` | What sets winners apart: features at every Setup A breakout (trend study) and at every ≥ 30% drawdown (reversal study), by in-sample terciles, in- and out-of-sample; veto filters on the bot's portfolio. |
| `a-entry.ts` | Setup A's entry timing: the breakout close (today) vs a pullback to the broken level within two days vs half and half. |
| `preload.ts` | Fill the kline cache for one interval (`npx tsx research/preload.ts 1h`, resumable; the 1h cache is ~1.3 GB). |
| `variants.ts` | Upgrade research for v1.1 (H1–H8: breadth, ranking, sizing, slots, risk cap per bar, exits, BTC regime, stoch-only). Bot-like compounding portfolio marked to market every bar; grid selected on in-sample only. Dataset cached in `research/.cache/variants-dataset.json`. |
| `setup-v1.ts` | Backtest with point-in-time liquidity (trailing 30-day average daily quote volume at the signal), breadth (pairs signalling on the same bar), in-/out-of-sample split at 2024-07-01, per-year results, listed vs delisted, bootstrap 95% CI and a bot-like portfolio (most liquid first, ≤ 15 open, 1% risk). |

Methodology rules (docs/ROADMAP.md §2): hypotheses and parameters fixed before looking at results;
thresholds chosen on in-sample only; costs always included; findings reported as they are.

The first full run downloads ~650 pairs × 4h since 2021 (~15 minutes); later runs use the cache.
