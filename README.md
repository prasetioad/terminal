# Orderflow Terminal

Real-time crypto orderflow terminal: Binance spot candles with "big trade" bubbles
(aggressive taker orders above a USD threshold) from Binance, Bybit, OKX, KuCoin
(spot + perpetual) and Coinbase (spot).

```bash
npm install
npm run dev   # http://localhost:3000
```

> **Network note (Indonesia):** ISP DNS ("Internet Positif") blocks binance.com, bybit.com,
> okx.com and coinbase.com. Set the machine's DNS to 1.1.1.1 / 8.8.8.8 (system-wide, since the
> Next.js server also fetches instrument lists). Without it the terminal still runs on Binance
> spot via binance.vision, and the other sources show as "Unreachable".

## Data flow

```
venue feeds ─┬─ Binance spot trades ─→ CandleAggregator ─→ chart candles + indicators
             ├─ all trades ─→ FlowStore (taker buy/sell per venue per bar) ─→ Delta · CVD
             ├─ all trades ─→ PressureTape (buy/sell per source per second) ─→ market pressure
             └─ all trades ─→ TakerOrderClusterer ─→ TradeLog ─→ bubbles · feed · stats · alerts
                                                               └─→ large pressure
```

**Pressure panel** (right column): *Large pressure* is the aggressive buy vs sell notional of the
big trades (≥ the threshold); *Market pressure* is the same for every print, whatever its size.
Both follow the source checkboxes and share one range (1m / 5m / 15m / 1h / 4h / 1D / session).
Trades are only seen live, so until the page has been open for the whole range the panel says
how much it covers ("Collecting · 42m of 4h"); ranges over 15 min are exact to the minute. The line below
compares the large trades' direction with the **rest** of the market (all trades minus the large
ones — comparing with the total would lean towards "with", since the large trades are part of it):
*With flow* = size pushes the same way as everyone else; *Against flow* = size pushes
against the crowd (absorption / positioning). "% vol" (next to the large threshold) is the large trades' share of all volume.

**Timeframes:** 1m, 5m, 15m, 1h, 4h, 1D (Binance klines; bars align to UTC as on the exchange,
so daily bars are labelled by their UTC date).

## Indicators & drawings

- **Indicators** (`ƒx Indicators`): Volume, Delta, Cumulative Volume Delta, Volume Profile
  (visible range or per day/session — POC, VAH/VAL, LVN zones), VWAP (day/week/session anchor,
  σ bands), Sessions (Asia/London/New York in local exchange hours, DST-aware; hidden — like
  per-day / per-session volume profiles — on timeframes where a period spans fewer than 3 bars), and
  the **MaxFlow+ Ultimate** oscillator (below). Each has a settings dialog; the setup is saved in the
  browser.
- **MaxFlow+ Ultimate** (`lib/maxflow.ts` engine, `lib/indicators/maxflow.ts` view) — port of the
  Pine script "MaxFlow+ Ultimate (5-in-1 Engine)": WaveTrend columns (wt1 yellow, wt2 blue) with
  ±60 OB/OS limits (±50 in the Scalping preset), money flow (RSI of hlc3 × volume) and a daily
  VWAP wave as areas, red/green dots on wt1/wt2 crosses beyond the limits. Feature toggles:
  regular/hidden divergence (wt1 pivots 5/5, marked once confirmed 5 bars later), higher-timeframe
  bias (background tint + dot filter), ATR-scaled limits, money-flow EMA(20) "POC" line and
  early-warning dots (any wt1/wt2 cross inside the limits, as `ta.cross` in the script: orange above
  zero, aqua below). Deviations from Pine: the HTF WaveTrend is built from the chart's own bars
  (the in-progress HTF bar as it stood at each bar, so nothing repaints), and dots are blocked while
  the HTF bias is still unknown.
- **MaxFlow+ OF (experimental)** (`lib/maxflowOF.ts`, `lib/indicators/maxflowOF.ts`) — a clone of
  MaxFlow+ Ultimate on real orderflow; the original is left untouched (the clone calls its engine).
  The money-flow area becomes a taker-flow oscillator (100 × EMA(buy − sell) ÷ EMA(volume), spot +
  perp), and the main dots can be filtered by flow — *spot-led* (default: spot takers net on the
  signal's side over the last 3 bars), *absorption* (price new extreme, CVD not), *spot + perp
  flow*, *flow momentum*. Rejected dots show as grey rings; dots sit on the bar they become known
  (the original plots them one bar early); optional CVD-divergence markers (◆). The legend scores
  the loaded history: count · win rate · average return after N bars for kept vs rejected dots.
  Offline test (8 pairs × 5m/15m/1h, last 40 % out-of-sample, before costs): spot-led and absorption
  improved on the original in 6/6 and 5/6 cells; flow momentum made it worse; nothing reached
  |t| ≥ 2, so treat it as a research tool, not a proven signal.
- **Setup v1 · MaxFlow+ × Stoch long** (`lib/setups/setupV1.ts`, overlay `lib/indicators/setupV1.ts`) —
  the first validated setup (research and numbers in `docs/ROADMAP.md`): on 4h, a MaxFlow+ green dot
  then a Stochastic cross up from below 20 → long at the close, −15% disaster stop, exit at the first
  red dot. The overlay marks every entry, stop, exit (with its %), the open position and the score.
  One engine serves the research, the chart, the scanner and (later) the bot.
- **Scanner** (chart toolbar): Setup v1 on every pair's last closed 4h bar — new entries, exits and
  open positions, filters for 24h volume and Stochastic preset, browser notifications for new
  entries; a row opens the pair on 4h with the overlay. Server route `/api/setups/scan`, rescanned
  once per closed bar; it fetches through `fetchKlinesBulk` (one host, 4 at a time, backs off on the
  IP's used weight and 429s) so a scan never starves the chart.
- Delta/CVD sources: *Binance* (spot/perp, with kline history) or *All venues* (live since load).
- **Delta candles:** each Delta bar opens at 0 and closes at the bar's delta, with wicks at the
  highest / lowest the running delta reached inside the bar (`FlowStore` follows every selectable
  source set print by print). A wick beyond the close = delta pushed back (absorbed); a wick on the
  other side of zero = that side led before the bar turned. Only bars seen live have wicks — klines
  carry totals, not the path. *Wicks* in the settings switches back to plain columns.
- **Liquidity Heatmap**: resting order-book liquidity over time (bright = walls), the current depth
  right of the live bar, and the largest bid/ask wall + books-in-sync count in the legend.
  *All venues* sums the **global book** of 9 sources; *Binance only* is also available.
  Its settings (⚙) hold a CoinGlass-style **colour scale** with draggable Min / Max handles in
  USD: liquidity below Min isn't drawn, at or above Max gets the brightest colour; *Auto*
  stretches the colours to a contrast-based percentile of what's on screen. Indicators opt in
  to this control via `colorScaleParams` + `colorScale()`.
- Indicator settings preview **live** on the chart; *Apply* keeps them, *Cancel* / Esc reverts.
- The price-pane indicator list (top left) **collapses / expands** like TradingView; the state
  is remembered.

### Global order book

| Venue | Feed | Sync check |
|---|---|---|
| Binance spot / USDⓈ-M | REST snapshot + `@depth@100ms` (futures under `/public`) | `U = u+1` / `pu = u` |
| Bybit spot / linear | `orderbook.1000` WS snapshot + deltas | `u` +1 per message |
| OKX spot / swap | `books` (400) WS snapshot + updates | `prevSeqId = seqId` (checksum no longer sent) |
| KuCoin spot / futures | REST snapshot via `/api/kucoin/book` (no CORS) + `level2` diffs | sequence ranges |
| Coinbase | Advanced Trade `level2` (public; the Exchange feed's needs auth) | `sequence_num` per connection |

A gap re-fetches the snapshot or re-subscribes. All books run in a **Web Worker**
(`lib/heatmap/heatmap.worker.ts`); only one frame per second reaches the page. Sockets are
open only while a heatmap indicator exists.

### Heatmap history (IndexedDB)

The worker stores a 5 s downsampled copy (max per price bucket) in one-minute chunks, keeps
12 h (`RETENTION_MS`), and loads the last 6 h when a symbol opens.

- **Schema migrations** — `MIGRATIONS` in `lib/persistence/heatmapRepository.ts`; the DB version
  is the list length. To change the schema, *append* a migration (never edit or reorder old ones);
  browsers on any older version are upgraded step by step with their data.
- **Moving to another database** — everything goes through the `HeatmapRepository` interface and
  chunks are self-describing (symbol, step, frames). Implement the interface for the new store
  (e.g. a server API) and move existing data with `copyHistory(from, to)`.

- **Drawing tools** (left strip): trend line, horizontal line, rectangle, Fibonacci retracement;
  magnet (snap to OHLC), hide, delete all. Select to recolour, set the line width (1–4 px,
  default 1) or delete (Del); Esc cancels, Alt+T/H/R/F arms a tool. Drawings are saved per
  symbol and anchored in time/price.
- **Long / short position** (one toolbar button with a menu, as in TradingView; Alt+L / Alt+S):
  one click places entry, stop (≈ 40 px away) and target at 2R, 20 bars wide. Drag the handles
  on the left edge (entry, target, stop) or the right edge (width); prices snap to the tick.
  ⚙ Settings: entry / profit / stop levels, account size, **position size by risk** (TradingView's
  default: 25 % of a 1,000 account; % or USDT), **by quantity** or **by order value**, leverage and
  fee per side. It computes quantity, order value, margin, P&L at target and stop (net of fees),
  risk of account and R:R, and walks the bars after the entry: target hit / stop hit / open P&L
  / closed at the end (a bar touching both counts as the stop). Stats show on hover or when
  selected, or always (option).
- **Undo / redo** (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y, or the arrows in the tool strip): every
  drawing change — add, move, resize, delete, clear all, colour, width, profile options — up to
  100 steps per symbol (history starts fresh when the symbol changes or the page reloads).
- **Range profiles** (drag across the bars to profile; resize by the edge handles, move by the body,
  ⚙ Settings when selected). Volume comes from Binance klines at a resolution set by the range's
  length alone (finest with ≤ 3,000 bars: 1m, 3m, 5m…), fetched in cached 1,000-bar chunks — so a
  profile is identical on every chart timeframe and isn't cut off by how much history the chart
  holds. The settings panel shows the POC / VAH / VAL and the resolution used.
  - *Fixed range volume profile* (Alt+V) — TradingView's FRVP: rows layout (number of rows /
    ticks per row), Up/Down · Total · Delta volume (up/down by bar direction, as TradingView
    does), value area %, width % of the box, left/right placement, values, VAH/VAL lines,
    extend right. Defaults as TradingView (24 rows, 70 %, width 30 %, left).
  - *Orderflow profile* (Alt+O) — for Fabio Valentini's approach: rows coloured by aggressor
    (taker) delta, LVN zones, POC, VAH and VAL extended right as trade levels, and a summary of
    the range's delta and profile shape (P = buyers in control, b = sellers in control, D = balance).
- **Undo / redo** (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y, or the arrows in the tool strip): every
  drawing change — add, move, resize, delete, clear all, colour, width, profile options — up to
  100 steps per symbol (history starts fresh when the symbol changes or the page reloads).
- **Range profiles** (drag across the bars to profile; resize by the edge handles, move by the body):
  - *Fixed range volume profile* (Alt+V) — TradingView-style: up/down volume per row, POC,
    value area (VAH/VAL shown when selected).
  - *Orderflow profile* (Alt+O) — for Fabio Valentini's approach: rows coloured by aggressor delta,
    LVN zones, POC, VAH and VAL extended right as trade levels, and a summary of the range's delta
    and profile shape (P = buyers in control, b = sellers in control, D = balance).
  - When selected, the inspector sets rows, value area % and whether levels extend right.
- **Measure** (ruler button, Alt+M, or Shift+drag): price change and %, bars and duration, plus
  volume and aggressor delta traded in the span. Temporary — cleared by the next click or Esc.
- Adding an indicator = one module in `lib/indicators/` implementing `IndicatorDefinition`,
  registered in `lib/indicators/registry.ts`.

## Layout

| Path | Role |
|---|---|
| `components/OrderflowTerminal.tsx` | Layout and UI state only |
| `hooks/useOrderflow.ts` | Data pipeline + render batching (chart per frame, React state every 200 ms) |
| `hooks/useMarketStreams.ts` | One `ManagedSocket` per feed, diffed by key |
| `lib/streams/ManagedSocket.ts` | Reconnect/backoff, host rotation, heartbeats, stale watchdog |
| `lib/streams/{binance,bybit,okx,coinbase,kucoin}.ts` | Venue adapters: URL, subscription, parsing → normalised `Trade` |
| `app/api/kucoin/connect/route.ts` | Fetches KuCoin's public WebSocket token server-side (its endpoint has no CORS) |
| `lib/venues.ts` | Venues, markets (S/P), `Listing` scale factors |
| `lib/clusterer.ts` | Merges fills of one taker order into one print |
| `lib/candles.ts`, `lib/tradeLog.ts` | Candle aggregation; big-trade buffer, filter, stats, `measurePressure` |
| `lib/pressure.ts` | `PressureTape` (every print, per source per second), dominance, large-vs-rest `compareFlow` |
| `hooks/useFlowPressure.ts` + `components/PressurePanel.tsx` | Large pressure (big trades ≥ threshold) and market pressure (all trades) over one shared 1m…1D/session range, plus whether large trades go with or against the rest of the market |
| `lib/server/` | `/api/pairs`: every Binance USDT spot pair (stablecoins / wrapped excluded), ordered by CMC rank (unranked last), with venue instrument lists (cached) |
| `lib/indicators/` | Indicator framework (`types`, `manager`, `registry`) and the indicator modules |
| `lib/orderbook/` | Venue order-book adapters (`SocketBook`, `SnapshotDiffBook`, one file per venue) |
| `lib/heatmap/` | Frames, worker engine + protocol, page-side store, rasteriser |
| `lib/persistence/` | IndexedDB helpers with migrations, heatmap repository |
| `lib/drawings/` | Drawing model, geometry (paint + hit-test), range profiles + their timeframe-independent kline store (`rangeData.ts`), long/short positions (`position.ts`: sizing, P&L, outcome), and `DrawingController` (interaction, undo, persistence) |
| `lib/flow.ts`, `lib/profile.ts`, `lib/sessions.ts` | Flow store, volume profile math, DST-aware sessions/anchors |
| `lib/chart/` | Time ↔ bar-index mapping, generic canvas primitive |
| `components/chart/` | Chart wrapper, legends, indicator picker/settings, drawing toolbar |

## Normalisation rules (verified against live data)

- **Aggressor side:** Binance `m=true` → SELL; Bybit `S`, OKX `side` and KuCoin `side` are the
  taker side; Coinbase `side` is the *maker* side, so it is inverted.
- **Sizes:** OKX swaps trade in contracts (× `ctVal × ctMult`); Binance/Bybit bundle cheap coins
  (`1000PEPEUSDT`, Bybit `SHIB1000USDT`) — prices and sizes are converted to per-coin units so
  every bubble sits on the Binance spot price axis. Perp bubbles can sit slightly off the candles:
  that is the real spot–perp basis.
- **KuCoin:** every connect needs a fresh public token (no API key), fetched via `/api/kucoin/connect`.
  Futures sizes are lots of `multiplier` contract units; BTC futures are named `XBT`; a bundled
  contract's unit is itself a bundle (`1000BONK`: price ÷ 1000, lot = multiplier × 1000 BONK).
- **Excluded:** Bybit block trades (negotiated off-book).

Exchange logos: [@web3icons/core](https://github.com/0xa3k5/web3icons) (MIT).
# terminal
