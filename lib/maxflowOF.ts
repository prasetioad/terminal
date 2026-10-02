import { computeMaxFlow, type MaxFlowOptions, type MaxFlowResult } from "./maxflow";
import type { Candle } from "./types";

/**
 * MaxFlow+ OF — an experimental clone of MaxFlow+ Ultimate that reads real orderflow.
 *
 * The WaveTrend engine is the original's (computeMaxFlow, unchanged). On top of it:
 *  - the money-flow area (an RSI of price × volume, which rises on any volume spike,
 *    selling included) is replaced by a flow oscillator: taker buy − sell over volume;
 *  - the main dots can be filtered by orderflow (each filter optional, all must pass):
 *      spotLed      — spot takers net buying (green) / selling (red) over the last bars
 *      absorption   — price made a lower low but CVD a higher low (green), or the mirror
 *      flowConfirm  — spot + perp takers on the signal's side over the last bars
 *      flowMomentum — the flow oscillator turning the signal's way
 *  - signals are placed on the bar they become known (the original plots them one bar
 *    early), so what the chart shows is what could have been traded;
 *  - the loaded history is scored: return after `horizon` bars for kept vs rejected
 *    signals, to experiment with the filters on each pair and timeframe.
 *
 * Fixed windows below are the ones the filters were tested with offline (8 pairs,
 * 5m / 15m / 1h, in- and out-of-sample); they are not tuned to any one market.
 */

export type FilterKey = "spotLed" | "absorption" | "flowConfirm" | "flowMomentum";

/** Taker flow per chart bar, in base units; NaN where the bar isn't covered. */
export interface FlowInputs {
  spotDelta: Float64Array;
  spotVolume: Float64Array;
  perpDelta: Float64Array;
  perpVolume: Float64Array;
}

export interface MaxFlowOFOptions extends MaxFlowOptions {
  filters: Record<FilterKey, boolean>;
  /** Bars the spot-led / flow-confirm windows look back over (signal bar included). */
  confirmBars: number;
  flowLength: number;
  horizon: number;
  /** Scan every bar for standalone CVD divergences (only when they're shown: it costs a pass). */
  markDeltaDivergences: boolean;
}

export interface FlowSignal {
  /** Bar the signal is known on (the bar after the WaveTrend cross). */
  index: number;
  /** wt1 on the cross bar, where the original plots its dot. */
  value: number;
  dir: 1 | -1;
  /** Filters this signal failed ("noData": the flow it needs isn't covered). */
  failed: (FilterKey | "noData")[];
}

export interface SignalScore {
  count: number;
  winRate: number; // 0…1
  avgBp: number; // mean return after `horizon` bars in the signal's direction, basis points
}

export interface MaxFlowOFResult {
  base: MaxFlowResult;
  /** 100 × EMA(taker buy − sell) ÷ EMA(volume), spot + perp. */
  flowOsc: Float64Array;
  signals: FlowSignal[];
  /** Orderflow divergences on their own (no WaveTrend), on the bar they appear. */
  deltaDivergences: { index: number; dir: 1 | -1 }[];
  score: { kept: SignalScore; rejected: SignalScore; horizon: number };
}

const RECENT_BARS = 5; // the new extreme is searched for in the last RECENT_BARS…
const PRIOR_BARS = 20; // …and compared with the extreme of the PRIOR_BARS before them
const MOMENTUM_BARS = 3;
const DIVERGENCE_COOLDOWN = 5;

const nanArray = (n: number) => new Float64Array(n).fill(Number.NaN);

function ema(src: ArrayLike<number>, length: number): Float64Array {
  const out = nanArray(src.length);
  const alpha = 2 / (length + 1);
  let prev = Number.NaN;
  for (let i = 0; i < src.length; i++) {
    if (Number.isNaN(src[i])) {
      prev = Number.NaN; // a gap restarts the average, as in Pine
      continue;
    }
    prev = Number.isNaN(prev) ? src[i] : alpha * src[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Sum of a series over [to − bars + 1, to]; NaN if any bar is missing. */
function windowSum(src: ArrayLike<number>, to: number, bars: number): number {
  if (to - bars + 1 < 0) return Number.NaN;
  let sum = 0;
  for (let j = to - bars + 1; j <= to; j++) sum += src[j];
  return sum;
}

/**
 * The divergence test of computeMaxFlowOF for every bar at once, in O(n): the extreme
 * of each window comes from a monotonic deque (earliest bar wins ties, like the scan).
 * 1 = divergence, 0 = none or not known.
 */
function divergenceSeries(candles: readonly Candle[], cvd: Float64Array, dir: 1 | -1): Uint8Array {
  const n = candles.length;
  const lows = dir > 0;
  const price = (j: number) => (lows ? candles[j].low : candles[j].high);
  const beats = (a: number, b: number) => (lows ? a < b : a > b); // a is a strictly better extreme

  /** Index of the window's extreme for windows of `size` bars ending at each bar. */
  const extremes = (size: number) => {
    const out = new Int32Array(n).fill(-1);
    const deque: number[] = [];
    let head = 0;
    for (let j = 0; j < n; j++) {
      while (deque.length > head && beats(price(j), price(deque[deque.length - 1]))) deque.pop();
      deque.push(j);
      if (deque[head] <= j - size) head++;
      if (j >= size - 1) out[j] = deque[head];
    }
    return out;
  };
  const recentExt = extremes(RECENT_BARS);
  const priorExt = extremes(PRIOR_BARS);
  const out = new Uint8Array(n);
  for (let s = RECENT_BARS + PRIOR_BARS - 1; s < n; s++) {
    const recent = recentExt[s];
    const prior = priorExt[s - RECENT_BARS];
    if (Number.isNaN(cvd[prior]) || Number.isNaN(cvd[recent])) continue;
    out[s] = Number(lows ? price(recent) < price(prior) && cvd[recent] > cvd[prior] : price(recent) > price(prior) && cvd[recent] < cvd[prior]);
  }
  return out;
}

function scoreOf(returns: number[]): SignalScore {
  const count = returns.length;
  if (count === 0) return { count, winRate: 0, avgBp: 0 };
  return {
    count,
    winRate: returns.filter((r) => r > 0).length / count,
    avgBp: returns.reduce((a, b) => a + b, 0) / count,
  };
}

export function computeMaxFlowOF(candles: readonly Candle[], flow: FlowInputs, o: MaxFlowOFOptions): MaxFlowOFResult {
  const n = candles.length;
  const base = computeMaxFlow(candles, o);

  const totalDelta = new Float64Array(n);
  const totalVolume = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Perp flow is optional (not every pair has a perp): count it where it exists.
    const perpD = Number.isNaN(flow.perpDelta[i]) ? 0 : flow.perpDelta[i];
    const perpV = Number.isNaN(flow.perpVolume[i]) ? 0 : flow.perpVolume[i];
    totalDelta[i] = flow.spotDelta[i] + perpD;
    totalVolume[i] = flow.spotVolume[i] + perpV;
  }

  const deltaEma = ema(totalDelta, o.flowLength);
  const volumeEma = ema(totalVolume, o.flowLength);
  const flowOsc = nanArray(n);
  for (let i = 0; i < n; i++) if (volumeEma[i] > 0) flowOsc[i] = (100 * deltaEma[i]) / volumeEma[i];

  // CVD over the covered stretch; NaN before it and across gaps.
  const cvd = nanArray(n);
  let running = Number.NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(totalDelta[i])) {
      running = Number.NaN;
      continue;
    }
    running = (Number.isNaN(running) ? 0 : running) + totalDelta[i];
    cvd[i] = running;
  }

  /** Price made a new extreme in the last RECENT_BARS that CVD didn't confirm. */
  const deltaDivergence = (s: number, dir: 1 | -1): boolean | null => {
    const from = s - RECENT_BARS - PRIOR_BARS + 1;
    if (from < 0) return null;
    const pick = (a: number, b: number, value: (j: number) => number, lowest: boolean) => {
      let best = a;
      for (let j = a + 1; j <= b; j++) if (lowest ? value(j) < value(best) : value(j) > value(best)) best = j;
      return best;
    };
    const lows = dir > 0;
    const price = (j: number) => (lows ? candles[j].low : candles[j].high);
    const prior = pick(from, s - RECENT_BARS, price, lows);
    const recent = pick(s - RECENT_BARS + 1, s, price, lows);
    if (Number.isNaN(cvd[prior]) || Number.isNaN(cvd[recent])) return null;
    return lows ? price(recent) < price(prior) && cvd[recent] > cvd[prior] : price(recent) > price(prior) && cvd[recent] < cvd[prior];
  };

  const signals: FlowSignal[] = [];
  for (const dot of base.dots) {
    if (dot.kind !== "green" && dot.kind !== "red") continue;
    const s = dot.index + 1;
    if (s >= n) continue;
    const dir: 1 | -1 = dot.kind === "green" ? 1 : -1;
    const failed: FlowSignal["failed"] = [];
    const check = (key: FilterKey, pass: boolean | null) => {
      if (!o.filters[key]) return;
      if (pass === null) {
        if (!failed.includes("noData")) failed.push("noData");
      } else if (!pass) failed.push(key);
    };
    const ratio = (delta: ArrayLike<number>, volume: ArrayLike<number>) => {
      const d = windowSum(delta, s, o.confirmBars);
      const v = windowSum(volume, s, o.confirmBars);
      return Number.isNaN(d) || !(v > 0) ? null : d / v;
    };
    const spot = ratio(flow.spotDelta, flow.spotVolume);
    const total = ratio(totalDelta, totalVolume);
    const momentum = s - MOMENTUM_BARS >= 0 ? flowOsc[s] - flowOsc[s - MOMENTUM_BARS] : Number.NaN;
    check("spotLed", spot === null ? null : dir * spot > 0);
    check("absorption", deltaDivergence(s, dir));
    check("flowConfirm", total === null ? null : dir * total > 0);
    check("flowMomentum", Number.isNaN(momentum) ? null : dir * momentum > 0);
    signals.push({ index: s, value: dot.value, dir, failed });
  }

  const deltaDivergences: MaxFlowOFResult["deltaDivergences"] = [];
  if (o.markDeltaDivergences) {
    const bull = divergenceSeries(candles, cvd, 1);
    const bear = divergenceSeries(candles, cvd, -1);
    let last = Number.NEGATIVE_INFINITY;
    for (let s = 1; s < n; s++) {
      for (const [dir, series] of [[1, bull], [-1, bear]] as const) {
        if (series[s] && !series[s - 1] && s - last >= DIVERGENCE_COOLDOWN) {
          deltaDivergences.push({ index: s, dir });
          last = s;
        }
      }
    }
  }

  const kept: number[] = [];
  const rejected: number[] = [];
  for (const sig of signals) {
    const exit = sig.index + o.horizon;
    if (exit >= n) continue;
    const ret = sig.dir * (candles[exit].close / candles[sig.index].close - 1) * 1e4;
    (sig.failed.length ? rejected : kept).push(ret);
  }

  return {
    base,
    flowOsc,
    signals,
    deltaDivergences,
    score: { kept: scoreOf(kept), rejected: scoreOf(rejected), horizon: o.horizon },
  };
}
