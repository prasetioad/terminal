import type { ITimeScaleApi, Logical, Time } from "lightweight-charts";
import type { Candle } from "../types";

/**
 * Conversions between wall-clock time and the chart's logical (bar index) axis.
 * The chart only knows bar positions, so times between bars are interpolated and
 * times before the first / after the last bar are extrapolated at the bar interval.
 * This keeps drawings and session bands anchored to real time across timeframes.
 */

const barMs = (c: Candle) => c.time * 1000;

/** Index of the last bar opening at or before `ms` (−1 if before the first bar). */
export function barIndexAt(candles: readonly Candle[], ms: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (barMs(candles[mid]) <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function timeToLogical(candles: readonly Candle[], intervalMs: number, ms: number): number | null {
  const n = candles.length;
  if (n === 0) return null;
  const first = barMs(candles[0]);
  const last = barMs(candles[n - 1]);
  if (ms <= first) return (ms - first) / intervalMs;
  if (ms >= last) return n - 1 + (ms - last) / intervalMs;
  const i = barIndexAt(candles, ms);
  const t0 = barMs(candles[i]);
  const t1 = barMs(candles[i + 1]);
  return i + (ms - t0) / (t1 - t0);
}

/**
 * X coordinate of a possibly fractional bar index. The chart API only resolves whole
 * indices (a fractional one comes back as 0), so interpolate between neighbours.
 */
export function logicalToX(timeScale: ITimeScaleApi<Time>, logical: number): number | null {
  const i = Math.floor(logical);
  const x0 = timeScale.logicalToCoordinate(i as Logical);
  if (x0 === null) return null;
  const frac = logical - i;
  if (frac === 0) return x0;
  const x1 = timeScale.logicalToCoordinate((i + 1) as Logical);
  return x1 === null ? null : x0 + (x1 - x0) * frac;
}

export function logicalToTime(candles: readonly Candle[], intervalMs: number, logical: number): number | null {
  const n = candles.length;
  if (n === 0) return null;
  if (logical <= 0) return barMs(candles[0]) + logical * intervalMs;
  if (logical >= n - 1) return barMs(candles[n - 1]) + (logical - (n - 1)) * intervalMs;
  const i = Math.floor(logical);
  const t0 = barMs(candles[i]);
  const t1 = barMs(candles[i + 1]);
  return t0 + (logical - i) * (t1 - t0);
}
