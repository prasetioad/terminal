import { anchorStart } from "./sessions";
import type { Candle } from "./types";

/**
 * MaxFlow+ Ultimate: a port of the "MaxFlow+ Ultimate (5-in-1 Engine)" Pine script.
 * WaveTrend (wt1/wt2) with overbought/oversold limits, money flow (RSI of price × volume),
 * a daily-anchored VWAP oscillator, and five optional features: auto divergence, a
 * higher-timeframe trend bias, ATR-scaled limits, a money-flow "POC" level and early
 * warning dots.
 *
 * Every series is causal (bar i only depends on bars ≤ i), and `na` is NaN, following
 * Pine's rules: an EMA restarts from its input after an na, division by zero is na.
 */

export interface MaxFlowOptions {
  scalping: boolean; // "Scalping (Fast)" preset instead of "Swing / Standard"
  obosFilter: boolean; // main dots only beyond the OB/OS limits
  divergence: boolean;
  hiddenDivergence: boolean;
  mtf: boolean; // filter main dots by the higher-timeframe bias
  htfMs: number;
  intervalMs: number;
  dynamicBands: boolean; // ATR-scaled OB/OS limits
  atrLength: number;
  volumeArea: boolean;
  earlyWarning: boolean;
  mfLength: number;
  mfSmooth: number;
  vwapLength: number;
}

export type DotKind = "red" | "green" | "earlyRed" | "earlyGreen";
export type DivergenceKind = "regularBull" | "regularBear" | "hiddenBull" | "hiddenBear";

/** A marker on the oscillator: bar index (offset already applied) and wt1 value. */
export interface Marker<K> {
  index: number;
  value: number;
  kind: K;
}

export interface MaxFlowResult {
  wt1: Float64Array;
  wt2: Float64Array;
  devUpper: Float64Array;
  devLower: Float64Array;
  moneyFlow: Float64Array;
  /** EMA(20) of money flow (the script's "Volume POC Dynamic Level"). */
  poc: Float64Array;
  vwapOsc: Float64Array;
  /** Higher-timeframe bias per bar: 1 bullish, −1 bearish, 0 not known yet. */
  htfBias: Int8Array;
  /** Chronological. */
  dots: Marker<DotKind>[];
  divergences: Marker<DivergenceKind>[];
}

/** Pivot strength on each side, as in the script (lbL = lbR = 5). */
export const PIVOT_BARS = 5;

const isNa = Number.isNaN;
const nanArray = (n: number) => new Float64Array(n).fill(Number.NaN);

/* ───────────────────────────── Pine ta.* ───────────────────────────── */

/** ta.ema: seeded with the first value; an na input yields na and restarts the average. */
function ema(src: ArrayLike<number>, length: number): Float64Array {
  const out = nanArray(src.length);
  const alpha = 2 / (length + 1);
  let prev = Number.NaN;
  for (let i = 0; i < src.length; i++) {
    prev = isNa(prev) ? src[i] : alpha * src[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** ta.sma: na until `length` consecutive values exist. */
function sma(src: ArrayLike<number>, length: number): Float64Array {
  const out = nanArray(src.length);
  let sum = 0;
  let missing = 0; // na values inside the window
  for (let i = 0; i < src.length; i++) {
    if (isNa(src[i])) missing++;
    else sum += src[i];
    if (i >= length) {
      if (isNa(src[i - length])) missing--;
      else sum -= src[i - length];
    }
    if (i >= length - 1 && missing === 0) out[i] = sum / length;
  }
  return out;
}

/** ta.rma (Wilder): seeded with the SMA of the first `length` values. */
function rma(src: ArrayLike<number>, length: number): Float64Array {
  const seed = sma(src, length);
  const out = nanArray(src.length);
  const alpha = 1 / length;
  let prev = Number.NaN;
  for (let i = 0; i < src.length; i++) {
    prev = isNa(prev) ? seed[i] : alpha * src[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** ta.rsi */
function rsi(src: ArrayLike<number>, length: number): Float64Array {
  const n = src.length;
  const up = nanArray(n);
  const down = nanArray(n);
  for (let i = 1; i < n; i++) {
    const change = src[i] - src[i - 1];
    up[i] = Math.max(change, 0);
    down[i] = Math.max(-change, 0);
  }
  const avgUp = rma(up, length);
  const avgDown = rma(down, length);
  const out = nanArray(n);
  for (let i = 0; i < n; i++) {
    const u = avgUp[i];
    const d = avgDown[i];
    if (isNa(u) || isNa(d)) continue;
    out[i] = d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  }
  return out;
}

/** ta.atr: Wilder average of the true range. */
function atr(candles: readonly Candle[], length: number): Float64Array {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return rma(tr, length);
}

/** ta.vwap(src): anchored to the UTC day, like TradingView's session anchor on crypto. */
function dailyVwap(candles: readonly Candle[], src: ArrayLike<number>): Float64Array {
  const out = nanArray(candles.length);
  let anchor = Number.NaN;
  let sumPV = 0;
  let sumV = 0;
  candles.forEach((c, i) => {
    const day = anchorStart("day", c.time * 1000);
    if (day !== anchor) {
      anchor = day;
      sumPV = 0;
      sumV = 0;
    }
    sumPV += src[i] * c.volume;
    sumV += c.volume;
    if (sumV > 0) out[i] = sumPV / sumV;
  });
  return out;
}

/* ───────────────────────────── WaveTrend ───────────────────────────── */

interface WaveState {
  esa: number;
  d: number;
  wt: number;
}

/** One WaveTrend step (esa → d → ci → wt1) from `state`, without mutating it. */
function waveStep(state: WaveState, src: number, channelLen: number, averageLen: number): WaveState {
  const a1 = 2 / (channelLen + 1);
  const a2 = 2 / (averageLen + 1);
  const esa = isNa(state.esa) ? src : a1 * src + (1 - a1) * state.esa;
  const diff = Math.abs(src - esa);
  const d = isNa(state.d) ? diff : a1 * diff + (1 - a1) * state.d;
  const ci = d === 0 ? Number.NaN : (src - esa) / (0.015 * d);
  const wt = isNa(ci) ? Number.NaN : isNa(state.wt) ? ci : a2 * ci + (1 - a2) * state.wt;
  return { esa, d, wt };
}

const EMPTY_WAVE: WaveState = { esa: Number.NaN, d: Number.NaN, wt: Number.NaN };

/**
 * WaveTrend wt1 on higher-timeframe bars, as each chart bar would have seen it live:
 * the HTF bar in progress is built from the chart bars so far (no look-ahead), and its
 * EMA state is only committed once the HTF bar closes.
 */
function htfWaveTrend(candles: readonly Candle[], htfMs: number, channelLen: number, averageLen: number): Float64Array {
  const out = nanArray(candles.length);
  let committed = EMPTY_WAVE;
  let bucket = Number.NaN;
  let high = 0;
  let low = 0;
  let close = 0;
  candles.forEach((c, i) => {
    const b = Math.floor((c.time * 1000) / htfMs);
    if (b !== bucket) {
      if (!isNa(bucket)) committed = waveStep(committed, (high + low + close) / 3, channelLen, averageLen);
      bucket = b;
      high = c.high;
      low = c.low;
    } else {
      high = Math.max(high, c.high);
      low = Math.min(low, c.low);
    }
    close = c.close;
    out[i] = waveStep(committed, (high + low + close) / 3, channelLen, averageLen).wt;
  });
  return out;
}

/* ───────────────────────────── engine ───────────────────────────── */

export function computeMaxFlow(candles: readonly Candle[], o: MaxFlowOptions): MaxFlowResult {
  const n = candles.length;
  const channelLen = o.scalping ? 6 : 9;
  const averageLen = o.scalping ? 10 : 12;
  const baseUpper = o.scalping ? 50 : 60;
  const baseLower = -baseUpper;

  const src = candles.map((c) => (c.high + c.low + c.close) / 3);

  // A. WaveTrend
  let state = EMPTY_WAVE;
  const wt1 = nanArray(n);
  for (let i = 0; i < n; i++) {
    state = waveStep(state, src[i], channelLen, averageLen);
    wt1[i] = state.wt;
  }
  const wt2 = sma(wt1, 4);

  // B. Dynamic volatility bands
  const atrValues = o.dynamicBands ? atr(candles, o.atrLength) : null;
  const devUpper = nanArray(n);
  const devLower = nanArray(n);
  for (let i = 0; i < n; i++) {
    // math.max(1.0, na) is na in Pine: no limits until the ATR has warmed up.
    const multiplier = atrValues ? Math.max(1, ((atrValues[i] / candles[i].close) * 100) * 0.5) : 1;
    const m = atrValues && isNa(atrValues[i]) ? Number.NaN : multiplier;
    devUpper[i] = baseUpper * m;
    devLower[i] = baseLower * m;
  }

  // C. Money flow and its EMA "POC" level
  const mfRsi = rsi(src.map((s, i) => s * candles[i].volume), o.mfLength).map((v) => v - 50);
  const moneyFlow = sma(mfRsi, o.mfSmooth).map((v) => v * 1.5);
  const poc = o.volumeArea ? ema(moneyFlow, 20) : nanArray(n);

  // D. VWAP oscillator
  const vwap = dailyVwap(candles, src);
  const vwapDiff = candles.map((c, i) => ((c.close - vwap[i]) / vwap[i]) * 100);
  const vwapOsc = ema(vwapDiff, o.vwapLength).map((v) => v * 6);

  // E. Higher-timeframe bias (never coarser than the chart itself)
  const htfBias = new Int8Array(n);
  if (o.mtf) {
    const htf = htfWaveTrend(candles, Math.max(o.htfMs, o.intervalMs), channelLen, averageLen);
    for (let i = 0; i < n; i++) htfBias[i] = isNa(htf[i]) ? 0 : htf[i] >= 0 ? 1 : -1;
  }

  // F + G. Main and early-warning dots, plotted on the previous bar (offset −1)
  const dots: Marker<DotKind>[] = [];
  for (let i = 1; i < n; i++) {
    const a = wt1[i];
    const b = wt2[i];
    const a1 = wt1[i - 1];
    const b1 = wt2[i - 1];
    if (isNa(a) || isNa(b) || isNa(a1) || isNa(b1)) continue;
    const crossUnder = a < b && a1 >= b1;
    const crossOver = a > b && a1 <= b1;
    if (!crossUnder && !crossOver) continue;

    // An unknown bias (HTF still warming up) lets neither signal through.
    const redBias = !o.mtf || htfBias[i] === -1;
    const greenBias = !o.mtf || htfBias[i] === 1;
    const red = crossUnder && a > 0 && redBias && (!o.obosFilter || a1 >= devUpper[i]);
    const green = crossOver && a < 0 && greenBias && (!o.obosFilter || a1 <= devLower[i]);
    // As in the script (ta.cross): an early dot is a wt1/wt2 cross in either direction
    // inside the limits — orange above zero, aqua below.
    const earlyRed = o.earlyWarning && a > 0 && a < devUpper[i] && !red;
    const earlyGreen = o.earlyWarning && a < 0 && a > devLower[i] && !green;

    const at = (kind: DotKind) => dots.push({ index: i - 1, value: a1, kind });
    if (red) at("red");
    if (green) at("green");
    if (earlyRed) at("earlyRed");
    if (earlyGreen) at("earlyGreen");
  }

  // H. Divergence between wt1 pivots and price, confirmed PIVOT_BARS later
  const divergences: Marker<DivergenceKind>[] = [];
  if (o.divergence) {
    let prevLow: { price: number; wt: number } | null = null;
    let prevHigh: { price: number; wt: number } | null = null;
    for (let c = PIVOT_BARS; c + PIVOT_BARS < n; c++) {
      const wt = wt1[c];
      if (isNa(wt)) continue;
      let isLow = true;
      let isHigh = true;
      for (let k = 1; k <= PIVOT_BARS && (isLow || isHigh); k++) {
        for (const j of [c - k, c + k]) {
          const v = wt1[j];
          if (isNa(v) || v <= wt) isLow = false;
          if (isNa(v) || v >= wt) isHigh = false;
        }
      }
      const at = (kind: DivergenceKind) => divergences.push({ index: c, value: wt, kind });

      if (isLow) {
        const price = candles[c].low;
        if (prevLow && wt < 0) {
          if (price < prevLow.price && wt > prevLow.wt) at("regularBull");
          else if (o.hiddenDivergence && price > prevLow.price && wt < prevLow.wt) at("hiddenBull");
        }
        prevLow = { price, wt };
      }
      if (isHigh) {
        const price = candles[c].high;
        if (prevHigh && wt > 0) {
          if (price > prevHigh.price && wt < prevHigh.wt) at("regularBear");
          else if (o.hiddenDivergence && price < prevHigh.price && wt > prevHigh.wt) at("hiddenBear");
        }
        prevHigh = { price, wt };
      }
    }
  }

  return { wt1, wt2, devUpper, devLower, moneyFlow, poc, vwapOsc, htfBias, dots, divergences };
}
