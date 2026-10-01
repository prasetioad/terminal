import type { UTCTimestamp } from "lightweight-charts";
import { CHART_SOURCE, type Listing, type SourceId } from "./venues";

export type Side = "BUY" | "SELL";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

/**
 * A normalised taker print. Prices and sizes are per base unit (see Listing), so
 * trades from every venue share the Binance spot price axis.
 */
export interface Trade {
  id: string; // `${source}:${venue trade id}`, unique across venues
  source: SourceId;
  price: number; // volume-weighted when several fills were merged
  qty: number; // base units
  usd: number;
  time: number; // ms
  side: Side; // aggressor side
  fills: number; // venue prints merged into this trade
}

export interface Candle {
  time: UTCTimestamp; // bucket open, seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base asset volume
  buyVolume: number; // taker (aggressive) buy volume, base asset; sell = volume − buyVolume
}

export interface Ticker24h {
  lastPrice: number;
  open: number;
  high: number;
  low: number;
  changePct: number;
  quoteVolume: number;
}

export interface FlowStats {
  count: number;
  buyCount: number;
  sellCount: number;
  buyUsd: number;
  sellUsd: number;
  largest: Trade | null;
}

/** Chart timeframes in ms. Keys are Binance kline intervals; bars align to UTC like Binance's. */
export const INTERVALS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
} as const;

export type IntervalKey = keyof typeof INTERVALS;

/** How timeframes are shown (TradingView style). */
export const INTERVAL_LABELS: Record<IntervalKey, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1D",
};

/** A Binance USDT spot pair, ranked by CoinMarketCap market cap, with its listings on every venue. */
export interface Pair {
  symbol: string; // Binance spot symbol, e.g. "BTCUSDT"
  base: string; // e.g. "BTC"
  name: string; // e.g. "Bitcoin"
  rank: number | null; // CoinMarketCap rank; null when CMC doesn't rank the coin
  precision: number; // price decimals, from the Binance spot tickSize
  minMove: number; // tickSize
  listings: Listing[]; // always includes the chart source
}

export interface PairsResponse {
  pairs: Pair[];
  ranking: "cmc-live" | "cmc-snapshot";
  /** Sources whose instrument list could not be loaded; their listings are missing. */
  unavailableSources: SourceId[];
  updatedAt: number;
}

const binanceSpotListing = (symbol: string): Listing => ({
  source: CHART_SOURCE,
  symbol,
  priceScale: 1,
  qtyScale: 1,
});

/** Used until /api/pairs answers, or if it fails. */
export const DEFAULT_PAIRS: Pair[] = [
  { symbol: "BTCUSDT", base: "BTC", name: "Bitcoin", rank: 1, precision: 2, minMove: 0.01, listings: [binanceSpotListing("BTCUSDT")] },
  { symbol: "ETHUSDT", base: "ETH", name: "Ethereum", rank: 2, precision: 2, minMove: 0.01, listings: [binanceSpotListing("ETHUSDT")] },
];

export type HistoryStatus = "loading" | "ready" | "error";
