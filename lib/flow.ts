import type { SourceId } from "./venues";
import type { Trade } from "./types";

/** Aggressive volume in base units for one candle bucket. */
export interface FlowBar {
  buy: number;
  sell: number;
}

export interface SeedBar extends FlowBar {
  time: number; // bucket open, seconds
}

/** How far buy − sell travelled inside one bucket: its extremes since the bucket opened at 0. */
export interface DeltaRange {
  high: number;
  low: number;
}

/** A set of sources whose combined intrabar delta path is recorded. */
interface PathGroup {
  sources: ReadonlySet<SourceId>;
  /** Running delta and its extremes per bucket. */
  buckets: Map<number, DeltaRange & { delta: number }>;
}

const groupKey = (sources: readonly SourceId[]) => [...sources].sort().join(",");

/**
 * Per-source taker buy/sell volume, bucketed like the chart candles. Feeds the
 * Delta and CVD indicators. Sources can be seeded with history (Binance klines
 * carry taker-buy volume); every other source only has what streamed live.
 *
 * For each group in `pathGroups` it also follows the group's combined delta print by
 * print inside every bucket, so a bar's intrabar high and low are known (Delta's
 * wicks). Klines only carry totals, so seeded history has no such range.
 */
export class FlowStore {
  private intervalMs: number;
  private resetAt = Date.now();
  private readonly bySource = new Map<SourceId, Map<number, FlowBar>>();
  /** First bucket each source received live; history never overwrites it or later buckets. */
  private readonly liveFrom = new Map<SourceId, number>();
  private readonly paths = new Map<string, PathGroup>();
  private dirtyFrom = Number.POSITIVE_INFINITY;

  constructor(intervalMs: number, pathGroups: readonly (readonly SourceId[])[] = []) {
    this.intervalMs = intervalMs;
    for (const sources of pathGroups) this.paths.set(groupKey(sources), { sources: new Set(sources), buckets: new Map() });
  }

  /** Start over for a new dataset (symbol or timeframe changed). */
  reset(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.resetAt = Date.now();
    this.bySource.clear();
    this.liveFrom.clear();
    for (const group of this.paths.values()) group.buckets.clear();
    this.dirtyFrom = Number.POSITIVE_INFINITY;
  }

  /** Bucket (seconds) from which every source is covered live. */
  get liveStart(): number {
    return this.bucketOf(this.resetAt);
  }

  /**
   * Add history for a source. Buckets at or after the source's first live bucket
   * are skipped: they already hold live data, and the REST snapshot would double count it.
   */
  seed(source: SourceId, bars: Iterable<SeedBar>): void {
    const buckets = this.bucketsFor(source);
    const live = this.liveFrom.get(source) ?? Number.POSITIVE_INFINITY;
    let earliest = Number.POSITIVE_INFINITY;
    for (const bar of bars) {
      if (bar.time >= live) continue;
      buckets.set(bar.time, { buy: bar.buy, sell: bar.sell });
      earliest = Math.min(earliest, bar.time);
    }
    this.dirtyFrom = Math.min(this.dirtyFrom, earliest);
  }

  add(trade: Trade): void {
    const bucket = this.bucketOf(trade.time);
    const buckets = this.bucketsFor(trade.source);
    if (!this.liveFrom.has(trade.source)) this.liveFrom.set(trade.source, bucket);
    let bar = buckets.get(bucket);
    if (!bar) {
      bar = { buy: 0, sell: 0 };
      buckets.set(bucket, bar);
    }
    if (trade.side === "BUY") bar.buy += trade.qty;
    else bar.sell += trade.qty;

    // Prints are taken in arrival order, which is as close to time order as venues allow.
    const signed = trade.side === "BUY" ? trade.qty : -trade.qty;
    for (const group of this.paths.values()) {
      if (!group.sources.has(trade.source)) continue;
      let path = group.buckets.get(bucket);
      if (!path) {
        path = { delta: 0, high: 0, low: 0 };
        group.buckets.set(bucket, path);
      }
      path.delta += signed;
      if (path.delta > path.high) path.high = path.delta;
      if (path.delta < path.low) path.low = path.delta;
    }
    this.dirtyFrom = Math.min(this.dirtyFrom, bucket);
  }

  /**
   * Intrabar extremes of the combined delta of `sources` in one bucket, or null when
   * that group isn't tracked or the bucket holds history: the path then misses part of
   * the bar (its total no longer matches the bucket's delta).
   */
  deltaRange(time: number, sources: readonly SourceId[]): DeltaRange | null {
    const path = this.paths.get(groupKey(sources))?.buckets.get(time);
    if (!path) return null;
    const totals = this.totals(time, sources);
    if (!totals) return null;
    // Both are sums of the same prints in a different order: allow for rounding.
    const tolerance = 1e-9 * (totals.buy + totals.sell);
    return Math.abs(totals.buy - totals.sell - path.delta) <= tolerance ? path : null;
  }

  /** Summed buy − sell of `sources` in one bucket. */
  delta(time: number, sources: readonly SourceId[]): number {
    let delta = 0;
    for (const source of sources) {
      const bar = this.bySource.get(source)?.get(time);
      if (bar) delta += bar.buy - bar.sell;
    }
    return delta;
  }

  /** Summed taker buy and sell of `sources` in one bucket; null if none of them has the bucket. */
  totals(time: number, sources: readonly SourceId[]): FlowBar | null {
    let found = false;
    const sum = { buy: 0, sell: 0 };
    for (const source of sources) {
      const bar = this.bySource.get(source)?.get(time);
      if (!bar) continue;
      found = true;
      sum.buy += bar.buy;
      sum.sell += bar.sell;
    }
    return found ? sum : null;
  }

  /** Earliest bucket (seconds) changed since the last call, or null. */
  takeDirtyFrom(): number | null {
    const from = this.dirtyFrom;
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    return from === Number.POSITIVE_INFINITY ? null : from;
  }

  private bucketOf(ms: number): number {
    return (Math.floor(ms / this.intervalMs) * this.intervalMs) / 1000;
  }

  private bucketsFor(source: SourceId): Map<number, FlowBar> {
    let buckets = this.bySource.get(source);
    if (!buckets) {
      buckets = new Map();
      this.bySource.set(source, buckets);
    }
    return buckets;
  }
}
