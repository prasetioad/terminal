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
             └─ all trades ─→ TakerOrderClusterer ─→ TradeLog ─→ bubbles · feed · stats · alerts
```

## Indicators & drawings

- **Indicators** (`ƒx Indicators`): Volume, Delta, Cumulative Volume Delta, Volume Profile
  (visible range or per day/session — POC, VAH/VAL, LVN zones), VWAP (day/week/session anchor,
  σ bands), Sessions (Asia/London/New York in local exchange hours, DST-aware). Each has a
  settings dialog; the setup is saved in the browser.
- Delta/CVD sources: *Binance* (spot/perp, with kline history) or *All venues* (live since load).
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
  magnet (snap to OHLC), hide, delete all. Select to recolour/delete (Del), Esc cancels,
  Alt+T/H/R/F arms a tool. Drawings are saved per symbol and anchored in time/price.
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
| `hooks/useTakerPressure.ts` + `components/PressureBar.tsx` | Aggressive buy vs sell notional over 1m/5m/15m/session (visible trades only) |
| `lib/server/` | `/api/pairs`: CMC ranking × Binance spot pairs × venue instrument lists (cached) |
| `lib/indicators/` | Indicator framework (`types`, `manager`, `registry`) and the indicator modules |
| `lib/orderbook/` | Venue order-book adapters (`SocketBook`, `SnapshotDiffBook`, one file per venue) |
| `lib/heatmap/` | Frames, worker engine + protocol, page-side store, rasteriser |
| `lib/persistence/` | IndexedDB helpers with migrations, heatmap repository |
| `lib/drawings/` | Drawing model, geometry (paint + hit-test) and `DrawingController` (interaction, persistence) |
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
