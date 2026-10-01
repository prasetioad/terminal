import type { Candle } from "./types";

export interface ProfileRow {
  low: number; // price at the row's lower edge
  /** Base units. Taker buy / sell, or up-bar / down-bar volume with `split: "direction"`. */
  buy: number;
  sell: number;
}

export interface VolumeProfile {
  rows: ProfileRow[];
  rowSize: number;
  poc: number; // index of the point of control (highest-volume row)
  vaLow: number; // index range of the value area, inclusive
  vaHigh: number;
  lvns: LowVolumeNode[];
  maxVolume: number;
}

/** A thin area between heavier ones: row indices, inclusive. */
export interface LowVolumeNode {
  from: number;
  to: number;
}

export interface ProfileOptions {
  rows: number;
  /**
   * Fixed price height per row (e.g. ticks × tick size) instead of a row count; rows
   * then sit on multiples of it, like TradingView's "Ticks per row". Capped at MAX_ROWS.
   */
  rowSize?: number;
  /**
   * How a bar's volume splits in two: by its taker-buy share (default), or entirely to
   * "up" or "down" by the bar's direction (close vs open), as TradingView does.
   */
  split?: "taker" | "direction";
  valueAreaPct: number; // e.g. 70
  /** A local minimum below this share of the POC volume counts as a low volume node. */
  lvnRatio: number; // e.g. 0.35
}

const total = (r: ProfileRow) => r.buy + r.sell;

export const MAX_ROWS = 1_000;

/** Share of a bar's volume that goes to `buy`. */
function buyShareOf(c: Candle, split: ProfileOptions["split"]): number {
  if (split === "direction") return c.close > c.open ? 1 : c.close < c.open ? 0 : 0.5;
  return Math.min(1, Math.max(0, c.buyVolume / c.volume));
}

/**
 * Volume at price from OHLCV bars. Each bar's volume is spread evenly over its
 * high–low range (the usual approximation when individual prints aren't stored) and
 * split in two per `opts.split`.
 */
export function buildProfile(candles: readonly Candle[], from: number, to: number, opts: ProfileOptions): VolumeProfile | null {
  const start = Math.max(0, from);
  const end = Math.min(candles.length - 1, to);
  if (end < start) return null;

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = start; i <= end; i++) {
    lo = Math.min(lo, candles[i].low);
    hi = Math.max(hi, candles[i].high);
  }
  if (!(hi > lo)) return null;

  let count: number;
  let rowSize: number;
  if (opts.rowSize !== undefined && opts.rowSize > 0) {
    rowSize = opts.rowSize;
    lo = Math.floor(lo / rowSize) * rowSize;
    count = Math.max(1, Math.ceil((hi - lo) / rowSize - 1e-9));
    if (count > MAX_ROWS) {
      rowSize = (hi - lo) / MAX_ROWS;
      count = MAX_ROWS;
    }
  } else {
    count = Math.min(MAX_ROWS, Math.max(1, Math.round(opts.rows)));
    rowSize = (hi - lo) / count;
  }
  const rows: ProfileRow[] = Array.from({ length: count }, (_, i) => ({ low: lo + i * rowSize, buy: 0, sell: 0 }));
  const rowOf = (price: number) => Math.min(count - 1, Math.max(0, Math.floor((price - lo) / rowSize)));

  for (let i = start; i <= end; i++) {
    const c = candles[i];
    if (c.volume <= 0) continue;
    const buyShare = buyShareOf(c, opts.split);
    const first = rowOf(c.low);
    const last = rowOf(c.high);
    if (first === last) {
      rows[first].buy += c.volume * buyShare;
      rows[first].sell += c.volume * (1 - buyShare);
      continue;
    }
    const span = c.high - c.low;
    for (let r = first; r <= last; r++) {
      const overlap = Math.min(c.high, rows[r].low + rowSize) - Math.max(c.low, rows[r].low);
      const vol = (c.volume * Math.max(0, overlap)) / span;
      rows[r].buy += vol * buyShare;
      rows[r].sell += vol * (1 - buyShare);
    }
  }

  let sum = 0;
  let weighted = 0;
  let maxVolume = 0;
  for (let r = 0; r < count; r++) {
    const v = total(rows[r]);
    sum += v;
    weighted += v * r;
    maxVolume = Math.max(maxVolume, v);
  }
  if (sum <= 0) return null;

  // POC = highest-volume row; ties go to the row nearest the volume-weighted centre.
  const centre = weighted / sum;
  let poc = -1;
  for (let r = 0; r < count; r++) {
    if (total(rows[r]) < maxVolume * (1 - 1e-9)) continue;
    if (poc < 0 || Math.abs(r - centre) < Math.abs(poc - centre)) poc = r;
  }

  // Value area: grow from the POC, each step taking the neighbouring pair of rows with more volume.
  let vaLow = poc;
  let vaHigh = poc;
  let inArea = total(rows[poc]);
  const target = (sum * opts.valueAreaPct) / 100;
  const pairVolume = (a: number, b: number) =>
    (a >= 0 && a < count ? total(rows[a]) : 0) + (b >= 0 && b < count ? total(rows[b]) : 0);
  while (inArea < target && (vaLow > 0 || vaHigh < count - 1)) {
    const up = vaHigh < count - 1 ? pairVolume(vaHigh + 1, vaHigh + 2) : -1;
    const down = vaLow > 0 ? pairVolume(vaLow - 1, vaLow - 2) : -1;
    if (up >= down) {
      const step = Math.min(2, count - 1 - vaHigh);
      for (let k = 1; k <= step; k++) inArea += total(rows[vaHigh + k]);
      vaHigh += step;
    } else {
      const step = Math.min(2, vaLow);
      for (let k = 1; k <= step; k++) inArea += total(rows[vaLow - k]);
      vaLow -= step;
    }
  }

  return { rows, rowSize, poc, vaLow, vaHigh, lvns: findLowVolumeNodes(rows, poc, opts.lvnRatio), maxVolume };
}

/**
 * Low volume nodes: pronounced valleys between heavier areas. Rows are smoothed over
 * 3 rows so a single sparse row doesn't register; qualifying rows are grouped into
 * zones, and a zone only counts if both sides rise to at least twice its level.
 */
function findLowVolumeNodes(rows: readonly ProfileRow[], poc: number, ratio: number): LowVolumeNode[] {
  const n = rows.length;
  const smooth = rows.map((_, i) => {
    let s = 0;
    let k = 0;
    for (let j = i - 1; j <= i + 1; j++) {
      if (j >= 0 && j < n) {
        s += total(rows[j]);
        k++;
      }
    }
    return s / k;
  });
  const ceiling = smooth[poc] * ratio;
  const edge = Math.max(2, Math.round(n * 0.05)); // profile tails are thin by nature, not valleys

  const zones: LowVolumeNode[] = [];
  let i = edge;
  while (i < n - edge) {
    if (smooth[i] > ceiling) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n - edge && smooth[j + 1] <= ceiling) j++;
    let floor = Number.POSITIVE_INFINITY;
    for (let k = i; k <= j; k++) floor = Math.min(floor, smooth[k]);
    const leftPeak = Math.max(...smooth.slice(0, i));
    const rightPeak = Math.max(...smooth.slice(j + 1));
    if (leftPeak >= floor * 2 && rightPeak >= floor * 2) zones.push({ from: i, to: j });
    i = j + 1;
  }
  return zones;
}
