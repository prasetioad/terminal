import type { Pressure } from "./pressure";
import type { SourceId } from "./venues";
import type { FlowStats, Trade } from "./types";

/** Every trade at or above this is kept, so lowering the threshold reveals past prints. */
export const STORE_FLOOR_USD = 10_000;

const MAX_TRADES = 25_000;
const TRIM_SLACK = 2_500; // trim in batches rather than on every push

export const EMPTY_STATS: FlowStats = {
  count: 0,
  buyCount: 0,
  sellCount: 0,
  buyUsd: 0,
  sellUsd: 0,
  largest: null,
};

/** What the viewer wants to see: shared by the feed, stats, bubbles and alerts. */
export interface TradeFilter {
  minUsd: number;
  hiddenSources: ReadonlySet<SourceId>;
}

export const isVisible = (trade: Trade, filter: TradeFilter): boolean =>
  trade.usd >= filter.minUsd && !filter.hiddenSources.has(trade.source);

export interface FlowSummary {
  feed: Trade[]; // newest first
  stats: FlowStats;
}

/**
 * Chronological buffer of big-enough trades from every source. The array identity
 * never changes, so the chart primitive can read it directly without copies.
 */
export class TradeLog {
  readonly trades: Trade[] = [];

  /** Records the trade if it clears the storage floor. Returns whether it was kept. */
  add(trade: Trade): boolean {
    if (trade.usd < STORE_FLOOR_USD) return false;
    // Venues and the clusterer deliver slightly out of order; keep the buffer sorted
    // (the chart binary-searches it). Inserts land at or near the end, so this is cheap.
    let i = this.trades.length;
    while (i > 0 && this.trades[i - 1].time > trade.time) i--;
    this.trades.splice(i, 0, trade);
    if (this.trades.length > MAX_TRADES + TRIM_SLACK) {
      this.trades.splice(0, this.trades.length - MAX_TRADES);
    }
    return true;
  }

  clear(): void {
    this.trades.length = 0;
  }

  /** One backwards pass: newest-first feed rows plus session stats for visible trades. */
  summarize(filter: TradeFilter, feedRows: number): FlowSummary {
    const feed: Trade[] = [];
    const stats: FlowStats = { ...EMPTY_STATS };
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const t = this.trades[i];
      if (!isVisible(t, filter)) continue;
      if (feed.length < feedRows) feed.push(t);
      stats.count++;
      if (t.side === "BUY") {
        stats.buyCount++;
        stats.buyUsd += t.usd;
      } else {
        stats.sellCount++;
        stats.sellUsd += t.usd;
      }
      if (!stats.largest || t.usd > stats.largest.usd) stats.largest = t;
    }
    return { feed, stats };
  }
}

/**
 * Visible aggressive buy vs sell notional of trades at or after `sinceMs`.
 * `trades` must be chronological (TradeLog.trades is); walks back from the newest.
 */
export function measurePressure(trades: readonly Trade[], filter: TradeFilter, sinceMs: number): Pressure {
  let buyUsd = 0;
  let sellUsd = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t.time < sinceMs) break;
    if (!isVisible(t, filter)) continue;
    if (t.side === "BUY") buyUsd += t.usd;
    else sellUsd += t.usd;
  }
  return { buyUsd, sellUsd };
}
