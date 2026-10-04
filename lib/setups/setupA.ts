import type { Candle } from "../types";

/**
 * Setup A — "Breakout 20D, chandelier 8×ATR, long" (docs/ROADMAP.md §4.7): catches a
 * coin trending on its own (ZEC Aug → Oct 2026), which Setup v1 never takes.
 *
 *   entry:  the close crosses above the highest high of the previous 120 bars (20 days
 *           on 4h) → buy that close. Validated filter: the last day's volume is at
 *           least 1.5× the 30-day daily average (`passes`). Optional (§4.12): only coins
 *           that lagged BTC over 30 days by more than `maxRs` (a base breaking out).
 *   stop:   8 × ATR(14) below the entry, resting (filled at the stop, or the open on a gap).
 *           Breakouts needing more than 25% are skipped.
 *   exit:   a close below the chandelier, highest close since entry − 8 × ATR(14).
 *
 * Every breakout is traded one at a time per pair, filtered or not, exactly as in the
 * research (a filtered breakout still occupies the pair). This is the one implementation
 * the chart, the scanner and the research share.
 */

export interface SetupATrade {
  entryIndex: number;
  entryTime: number; // ms, bar open
  entryPrice: number;
  /** Initial (resting) stop. */
  stopPrice: number;
  /** Last-day quote volume ÷ 30-day daily average at the entry. */
  surge: number;
  /** 30-day return minus BTC's at the entry (null without BTC bars). */
  rs: number | null;
  /** Whether the entry passes the filters: volume, and relative strength when `maxRs` is set. */
  passes: boolean;
  /** Chandelier level after each bar from the entry on (index 0 = entry bar). */
  trail: number[];
  exitIndex: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: "stop" | "trail" | null;
  /** Net return after COST (null while open). */
  ret: number | null;
}

export interface SetupAOptions {
  /** BTCUSDT bars on the same interval, for the relative strength. */
  btc?: readonly Candle[];
  /** Pass only entries with rs below this (e.g. −0.10); undefined = no relative-strength filter. */
  maxRs?: number;
}

export interface SetupAResult {
  trades: SetupATrade[];
  open: SetupATrade | null;
}

export const SETUP_A = {
  id: "setup-a",
  name: "Setup A · Breakout 20D × 8 ATR long",
  validatedInterval: 4 * 3_600_000,
  lookback: 120, // bars: 20 days on 4h
  atrLength: 14,
  atrMult: 8,
  maxStopPct: 0.25,
  minSurge: 1.5,
  cost: 0.001,
  /** Same warm-up as Setup v1, so both start trading on the same bar. */
  warmup: 220,
  minLiquidity30d: 1_000_000,
  /** Relative strength window: 30 days of 4h bars. */
  rsBars: 180,
  /** §4.12 candidate: coins that lagged BTC by more than 10% over 30 days. */
  maxRs: -0.1,
} as const;

const DAY_MS = 86_400_000;

/** ATR as in the research: running mean for the first bars, then Wilder's smoothing. */
export function atr(candles: readonly Candle[], length: number): number[] {
  const out: number[] = [];
  let a = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    a = i < length ? (i === 0 ? tr : (a * i + tr) / (i + 1)) : (a * (length - 1) + tr) / length;
    out.push(a);
  }
  return out;
}

/** Highest high of the `length` bars before i (NaN until defined), via a monotonic deque. */
function priorHigh(candles: readonly Candle[], length: number): number[] {
  const out = new Array<number>(candles.length).fill(Number.NaN);
  const dq: number[] = [];
  let head = 0;
  for (let i = 0; i < candles.length; i++) {
    while (head < dq.length && dq[head] < i - length) head++;
    if (i >= length) out[i] = candles[dq[head]].high;
    while (dq.length > head && candles[dq[dq.length - 1]].high <= candles[i].high) dq.pop();
    dq.push(i);
  }
  return out;
}

/** Last-day quote volume ÷ the trailing 30-day daily average, at bar i. */
export function volumeSurge(candles: readonly Candle[], i: number, intervalMs: number): number {
  const perDay = Math.max(1, Math.round(DAY_MS / intervalMs));
  const month = 30 * perDay;
  let day = 0;
  let total = 0;
  for (let j = Math.max(0, i - month + 1); j <= i; j++) {
    const q = candles[j].volume * candles[j].close;
    total += q;
    if (j > i - perDay) day += q;
  }
  const avg = total / Math.min(30, (i + 1) / perDay);
  return avg > 0 ? day / avg : 1;
}

/** 30-day return of `candles` at bar i minus BTC's over the same bars (by time); null if unknown. */
export function relativeStrength(candles: readonly Candle[], i: number, btc: readonly Candle[] | undefined): number | null {
  if (!btc?.length || i < SETUP_A.rsBars) return null;
  const at = (time: number) => {
    let lo = 0;
    let hi = btc.length - 1;
    if (btc[0].time > time) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (btc[mid].time <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const j = at(candles[i].time);
  if (j < SETUP_A.rsBars) return null;
  return candles[i].close / candles[i - SETUP_A.rsBars].close - btc[j].close / btc[j - SETUP_A.rsBars].close;
}

export function runSetupA(candles: readonly Candle[], intervalMs: number, options: SetupAOptions = {}): SetupAResult {
  const n = candles.length;
  const trades: SetupATrade[] = [];
  if (n <= SETUP_A.warmup + 1) return { trades, open: null };
  const hh = priorHigh(candles, SETUP_A.lookback);
  const a = atr(candles, SETUP_A.atrLength);
  const k = SETUP_A.atrMult;

  // An entry on the last bar is a position opened on that close (the scanner's "new entry").
  for (let s: number = SETUP_A.warmup; s < n; s++) {
    if (!(candles[s].close > hh[s] && candles[s - 1].close <= hh[s - 1])) continue;
    const entryPrice = candles[s].close;
    const stopDist = (k * a[s]) / entryPrice;
    if (stopDist > SETUP_A.maxStopPct) continue;
    const surge = volumeSurge(candles, s, intervalMs);
    const rs = relativeStrength(candles, s, options.btc);
    // A filtered breakout still occupies the pair, exactly as in the research.
    const rsOk = options.maxRs === undefined || (rs !== null && rs < options.maxRs);
    const trade: SetupATrade = {
      entryIndex: s,
      entryTime: candles[s].time * 1000,
      entryPrice,
      stopPrice: entryPrice * (1 - stopDist),
      surge,
      rs,
      passes: surge >= SETUP_A.minSurge && rsOk,
      trail: [entryPrice - k * a[s]],
      exitIndex: null,
      exitTime: null,
      exitPrice: null,
      exitReason: null,
      ret: null,
    };
    let best = entryPrice;
    let x = s + 1;
    for (; x < n; x++) {
      const bar = candles[x];
      if (bar.low <= trade.stopPrice) {
        close(trade, x, Math.min(bar.open, trade.stopPrice), "stop");
        break;
      }
      if (bar.close < best - k * a[x - 1]) {
        close(trade, x, bar.close, "trail");
        break;
      }
      best = Math.max(best, bar.close);
      trade.trail.push(best - k * a[x]);
    }
    if (trade.exitIndex === null) return { trades, open: trade };
    trades.push(trade);
    s = x;
  }
  return { trades, open: null };

  function close(trade: SetupATrade, i: number, price: number, reason: "stop" | "trail") {
    trade.exitIndex = i;
    trade.exitTime = candles[i].time * 1000;
    trade.exitPrice = price;
    trade.exitReason = reason;
    trade.ret = price / trade.entryPrice - 1 - SETUP_A.cost;
  }
}
