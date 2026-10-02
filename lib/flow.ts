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

/**
 * Per-source taker buy/sell volume, bucketed like the chart candles. Feeds the
 * Delta and CVD indicators. Sources can be seeded with history (Binance klines
 * carry taker-buy volume); every other source only has what streamed live.
 */
export class FlowStore {
  private intervalMs: number;
  private resetAt = Date.now();
  private readonly bySource = new Map<SourceId, Map<number, FlowBar>>();
  /** First bucket each source received live; history never overwrites it or later buckets. */
  private readonly liveFrom = new Map<SourceId, number>();
  private dirtyFrom = Number.POSITIVE_INFINITY;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  /** Start over for a new dataset (symbol or timeframe changed). */
  reset(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.resetAt = Date.now();
    this.bySource.clear();
    this.liveFrom.clear();
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
    this.dirtyFrom = Math.min(this.dirtyFrom, bucket);
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
