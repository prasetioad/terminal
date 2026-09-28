import type { OrderBook } from "../orderbook/book";
import type { SourceId } from "../venues";

/** Live sampling period. */
export const SAMPLE_MS = 1_000;
/** Resting liquidity is recorded within this share of the mid price. */
export const RANGE_PCT = 0.02;
/** Finest price bucket as a share of price (0.005%); rows can be merged coarser when drawing. */
const STEP_SHARE = 0.00005;

/** Resting size per price bucket for one source, trimmed to its non-empty extent. */
export interface FrameSlice {
  base: number; // bucket index of sizes[0]; bucket price = index × step
  sizes: Float32Array; // base units
}

export interface HeatmapFrame {
  time: number; // ms, start of the period the frame covers
  duration: number; // ms: SAMPLE_MS live, longer for downsampled history
  mid: number;
  slices: ReadonlyMap<SourceId, FrameSlice>;
}

/** Bucket size for a symbol: ≈0.005% of price, rounded to 1/2/2.5/5 × 10ⁿ, never below the tick. */
export function chooseStep(mid: number, minMove: number): number {
  const x = mid * STEP_SHARE;
  const exp = Math.pow(10, Math.floor(Math.log10(x)));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * exp).find((v) => v >= x) ?? 10 * exp;
  return Math.max(minMove, nice);
}

/** Mid of the first book that has both sides. */
export function midOf(books: ReadonlyMap<SourceId, OrderBook>): number | null {
  for (const book of books.values()) {
    const mid = book.mid();
    if (mid !== null) return mid;
  }
  return null;
}

/** Snapshot live books into a frame of absolute price buckets (index × step). */
export function buildFrame(time: number, mid: number, books: ReadonlyMap<SourceId, OrderBook>, step: number): HeatmapFrame {
  const lo = Math.floor((mid * (1 - RANGE_PCT)) / step);
  const hi = Math.ceil((mid * (1 + RANGE_PCT)) / step);
  const slices = new Map<SourceId, FrameSlice>();
  for (const [source, book] of books) {
    const dense = new Float32Array(hi - lo + 1);
    let first = dense.length;
    let last = -1;
    for (const levels of [book.bids, book.asks]) {
      for (const [price, size] of levels) {
        const i = Math.floor(price / step + 1e-9) - lo;
        if (i < 0 || i >= dense.length) continue;
        dense[i] += size;
        if (i < first) first = i;
        if (i > last) last = i;
      }
    }
    if (last >= first) slices.set(source, { base: lo + first, sizes: dense.slice(first, last + 1) });
  }
  return { time, duration: SAMPLE_MS, mid, slices };
}

/**
 * Merge consecutive frames into one covering [time, time + duration): per source and
 * bucket the maximum resting size, so short-lived walls survive downsampling.
 */
export function mergeFrames(frames: readonly HeatmapFrame[], time: number, duration: number): HeatmapFrame {
  const extents = new Map<SourceId, { lo: number; hi: number }>();
  for (const f of frames) {
    for (const [source, s] of f.slices) {
      const e = extents.get(source);
      const hi = s.base + s.sizes.length - 1;
      extents.set(source, e ? { lo: Math.min(e.lo, s.base), hi: Math.max(e.hi, hi) } : { lo: s.base, hi });
    }
  }
  const slices = new Map<SourceId, FrameSlice>();
  for (const [source, { lo, hi }] of extents) {
    const sizes = new Float32Array(hi - lo + 1);
    for (const f of frames) {
      const s = f.slices.get(source);
      if (!s) continue;
      for (let i = 0; i < s.sizes.length; i++) {
        const j = s.base - lo + i;
        if (s.sizes[i] > sizes[j]) sizes[j] = s.sizes[i];
      }
    }
    slices.set(source, { base: lo, sizes });
  }
  return { time, duration, mid: frames[frames.length - 1]?.mid ?? 0, slices };
}

/** Approximate bytes a frame occupies (for memory budgets). */
export function frameBytes(frame: HeatmapFrame): number {
  let bytes = 64;
  for (const s of frame.slices.values()) bytes += 32 + s.sizes.byteLength;
  return bytes;
}
