import { computeMaxFlow } from "../maxflow";
import type { Candle } from "../types";

/**
 * Setup v1 — "MaxFlow+ × Stochastic, long" (docs/ROADMAP.md §4.4), with the v1.1 filters.
 *
 *   entry: a MaxFlow+ green dot (on the bar it is known, at most DOT_WINDOW bars back),
 *          then a Stochastic %K/%D cross up from below 20 → buy the close of that bar.
 *   stop:  STOP_PCT below the entry (a disaster stop: tighter stops broke the edge).
 *   exit:  the first bearish WaveTrend cross above zero (the first red dot), at that close.
 *
 * Validated on 4h (25 pairs 2021–2026 and 99 pairs, in- and out-of-sample). This is the
 * one implementation the chart, the scanner and the bot share, and it reproduces the
 * research engine trade for trade. One position at a time per pair.
 */

export type StochPreset = "5,3,3" | "14,3,3" | "either";

export interface SetupV1Config {
  stoch: StochPreset;
  intervalMs: number;
}

export interface SetupTrade {
  entryIndex: number;
  entryTime: number; // ms, bar open
  entryPrice: number;
  stopPrice: number;
  /** null while the position is open. */
  exitIndex: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: "signal" | "stop" | null;
  /** Net return after COST (null while open). */
  ret: number | null;
}

export interface SetupResult {
  /** Closed trades, chronological. */
  trades: SetupTrade[];
  /** The position still open on the last bar, if any. */
  open: SetupTrade | null;
}

export interface SetupScore {
  count: number;
  winRate: number;
  avgRet: number;
  totalRet: number;
}

export const SETUP_V1 = {
  id: "setup-v1",
  name: "Setup v1 · MaxFlow+ × Stoch long",
  validatedInterval: 4 * 3_600_000,
  stopPct: 0.15,
  cost: 0.001, // round trip: fees + slippage
  dotWindow: 5,
  /** Bars before the first possible entry, so the indicators have settled. */
  warmup: 220,
  /**
   * v1.1 breadth filter: take entries only on bars where at least this many pairs
   * signal at once. The edge is market-wide capitulation; isolated signals averaged
   * ~0% on the survivorship-free universe (docs/ROADMAP.md §4.5).
   */
  minBreadth: 10,
  /** v1.1 liquidity filter: trailing 30-day average daily quote volume, USDT. */
  minLiquidity30d: 1_000_000,
} as const;

const DAY_MS = 86_400_000;

/** Average daily quote volume (≈ volume × close) over the 30 days up to and including bar `i`. */
export function liquidity30d(candles: readonly Candle[], i: number, intervalMs: number): number {
  const bars = Math.min(i + 1, Math.round((30 * DAY_MS) / intervalMs));
  let sum = 0;
  for (let j = i - bars + 1; j <= i; j++) sum += candles[j].volume * candles[j].close;
  return (sum / bars) * (DAY_MS / intervalMs);
}

/** Whether `result` opened a position on the last of its `bars` (a fresh entry signal). */
export const isFreshEntry = (result: SetupResult, bars: number) => result.open !== null && result.open.entryIndex === bars - 1;

const H = 3_600_000;
const D = 24 * H;

/** Higher timeframe of the MaxFlow+ trend bias for each chart timeframe (research: 1h→4h, 4h→1D, 1D→1W). */
export function biasTimeframe(intervalMs: number): number {
  if (intervalMs >= D) return 7 * D;
  if (intervalMs >= 4 * H) return D;
  if (intervalMs >= H) return 4 * H;
  if (intervalMs >= 15 * 60_000) return 4 * H;
  if (intervalMs >= 5 * 60_000) return H;
  return 15 * 60_000;
}

function sma(src: readonly number[], length: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= length) sum -= src[i - length];
    out.push(i >= length - 1 ? sum / length : Number.NaN);
  }
  return out;
}

/** Stochastic %K (smoothed) and %D, TradingView-style; neutral 50 until defined. */
export function stochastic(candles: readonly Candle[], kLength: number, kSmooth: number, dSmooth: number) {
  const raw = candles.map((_, i) => {
    if (i < kLength - 1) return 50;
    let hh = Number.NEGATIVE_INFINITY;
    let ll = Number.POSITIVE_INFINITY;
    for (let j = i - kLength + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    return hh > ll ? (100 * (candles[i].close - ll)) / (hh - ll) : 50;
  });
  const k = sma(raw, kSmooth).map((v) => (Number.isNaN(v) ? 50 : v));
  const d = sma(k, dSmooth).map((v) => (Number.isNaN(v) ? 50 : v));
  return { k, d };
}

const crossUpFromBelow = (s: { k: number[]; d: number[] }, i: number) =>
  s.k[i] > s.d[i] && s.k[i - 1] <= s.d[i - 1] && Math.min(s.k[i - 1], s.d[i - 1]) < 20;

export function runSetupV1(candles: readonly Candle[], config: SetupV1Config): SetupResult {
  const n = candles.length;
  const trades: SetupTrade[] = [];
  if (n <= SETUP_V1.warmup + 1) return { trades, open: null };

  const mf = computeMaxFlow(candles, {
    scalping: false,
    obosFilter: true,
    divergence: false,
    hiddenDivergence: false,
    mtf: true,
    htfMs: biasTimeframe(config.intervalMs),
    intervalMs: config.intervalMs,
    dynamicBands: false,
    atrLength: 14,
    volumeArea: false,
    earlyWarning: false,
    mfLength: 14,
    mfSmooth: 3,
    vwapLength: 8,
  });
  // Dots and crosses on the bar they become known (the cross bar + 1).
  const green = new Uint8Array(n);
  for (const dot of mf.dots) if (dot.kind === "green" && dot.index + 1 < n) green[dot.index + 1] = 1;
  const firstRed = new Uint8Array(n);
  for (let i = 1; i + 1 < n; i++) {
    if (mf.wt1[i] < mf.wt2[i] && mf.wt1[i - 1] >= mf.wt2[i - 1] && mf.wt1[i] > 0) firstRed[i + 1] = 1;
  }
  const fast = config.stoch !== "14,3,3" ? stochastic(candles, 5, 3, 3) : null;
  const slow = config.stoch !== "5,3,3" ? stochastic(candles, 14, 3, 3) : null;
  const trigger = (i: number) => (fast !== null && crossUpFromBelow(fast, i)) || (slow !== null && crossUpFromBelow(slow, i));

  let s = SETUP_V1.warmup;
  // An entry on the last bar is a position opened on that close (the scanner's "new entry").
  while (s < n) {
    let dot = false;
    for (let j = s; j >= s - SETUP_V1.dotWindow; j--) if (green[j]) dot = true;
    if (!dot || !trigger(s)) {
      s++;
      continue;
    }
    const entryPrice = candles[s].close;
    const trade: SetupTrade = {
      entryIndex: s,
      entryTime: candles[s].time * 1000,
      entryPrice,
      stopPrice: entryPrice * (1 - SETUP_V1.stopPct),
      exitIndex: null,
      exitTime: null,
      exitPrice: null,
      exitReason: null,
      ret: null,
    };
    let x = s + 1;
    for (; x < n; x++) {
      // The stop is checked first: within a bar, the order of high and low is unknown.
      if (candles[x].low <= trade.stopPrice) {
        close(trade, x, trade.stopPrice, "stop");
        break;
      }
      if (firstRed[x]) {
        close(trade, x, candles[x].close, "signal");
        break;
      }
    }
    if (trade.exitIndex === null) return { trades, open: trade };
    trades.push(trade);
    s = x + 1;
  }
  return { trades, open: null };

  function close(trade: SetupTrade, i: number, price: number, reason: "signal" | "stop") {
    trade.exitIndex = i;
    trade.exitTime = candles[i].time * 1000;
    trade.exitPrice = price;
    trade.exitReason = reason;
    trade.ret = price / trade.entryPrice - 1 - SETUP_V1.cost;
  }
}

export function scoreTrades(trades: readonly SetupTrade[]): SetupScore {
  const rets = trades.map((t) => t.ret ?? 0);
  const totalRet = rets.reduce((a, b) => a + b, 0);
  return {
    count: rets.length,
    winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : 0,
    avgRet: rets.length ? totalRet / rets.length : 0,
    totalRet,
  };
}
