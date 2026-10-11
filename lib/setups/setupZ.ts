import type { Candle } from "../types";

/**
 * Setup Z — a demand-zone add-on to a Setup v1 entry (docs/ROADMAP.md §4.50–4.52). When v1 buys a
 * green dot, Z rests a limit buy at the top of the nearest demand zone under it, with a stop just
 * under the zone; it exits with the v1 position (its first red dot) or at its own stop.
 *
 *   zone    where a rally started in the 120 bars before the signal: bar k whose close 4 bars later
 *           is ≥ 8% higher; the zone runs from the lowest low of bars k−3…k to bar k's body top
 *   choice  zones whose top is 2–10% under the signal close; the nearest (highest top)
 *   order   a limit buy at the zone's top, resting until the v1 position closes
 *   stop    0.5% under the zone's low; skipped when that is ≤ 1% or > 15% under the fill
 *
 * Settings fixed for the forward test (paper) on 2026-10-11, from a 54-cell grid where every cell
 * had a positive edge per trade in- and out-of-sample.
 */
export const SETUP_Z = {
  id: "setup-z",
  name: "Setup Z · demand-zone add-on to v1",
  lookback: 120,
  rally: 0.08,
  rallyBars: 4,
  minDist: 0.02,
  maxDist: 0.1,
  stopBuffer: 0.005,
  minStopPct: 0.01,
  maxStopPct: 0.15,
} as const;

export interface ZoneOrder {
  /** Limit price: the zone's top. */
  level: number;
  /** The zone's low − 0.5%. */
  stop: number;
}

/** The Z order for a v1 signal on bar s (its close), or null when no zone qualifies. */
export function zoneOrder(candles: readonly Candle[], s: number): ZoneOrder | null {
  const close = candles[s].close;
  let best: { lo: number; top: number } | null = null;
  for (let k = Math.max(3, s - SETUP_Z.lookback); k + SETUP_Z.rallyBars < s; k++) {
    if (candles[k + SETUP_Z.rallyBars].close / candles[k].close - 1 < SETUP_Z.rally) continue;
    const top = Math.max(candles[k].open, candles[k].close);
    if (!(top < close * (1 - SETUP_Z.minDist) && top > close * (1 - SETUP_Z.maxDist))) continue;
    if (best && top <= best.top) continue;
    let lo = Infinity;
    for (let j = k - 3; j <= k; j++) lo = Math.min(lo, candles[j].low);
    best = { lo, top };
  }
  return best ? { level: best.top, stop: best.lo * (1 - SETUP_Z.stopBuffer) } : null;
}

/** Fill price of the limit on a bar (the level, or the open on a gap under it), or null. */
export const limitFill = (bar: Candle, level: number): number | null => (bar.low <= level ? Math.min(bar.open, level) : null);

/** Whether a stop this far under the fill is one Z takes. */
export const stopInRange = (fill: number, stop: number) => {
  const d = 1 - stop / fill;
  return d > SETUP_Z.minStopPct && d <= SETUP_Z.maxStopPct;
};
