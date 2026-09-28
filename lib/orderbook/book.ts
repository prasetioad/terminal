export type BookSide = "bid" | "ask";

/**
 * A local price-level order book. Prices and sizes are stored normalised to the
 * chart's units (per base coin), so books of different venues can be summed.
 */
export class OrderBook {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();

  clear(): void {
    this.bids.clear();
    this.asks.clear();
  }

  /** Set a level's resting size; zero removes it. */
  set(side: BookSide, price: number, size: number): void {
    const levels = side === "bid" ? this.bids : this.asks;
    if (size > 0) levels.set(price, size);
    else levels.delete(price);
  }

  /** Mid price, or null while either side is empty. O(levels): call at sampling rate, not per update. */
  mid(): number | null {
    let bestBid = Number.NEGATIVE_INFINITY;
    let bestAsk = Number.POSITIVE_INFINITY;
    for (const p of this.bids.keys()) if (p > bestBid) bestBid = p;
    for (const p of this.asks.keys()) if (p < bestAsk) bestAsk = p;
    return Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : null;
  }

  /** Drop levels further than `pct` from `mid`, which a book never needs again. */
  prune(mid: number, pct: number): void {
    const lo = mid * (1 - pct);
    const hi = mid * (1 + pct);
    for (const p of this.bids.keys()) if (p < lo) this.bids.delete(p);
    for (const p of this.asks.keys()) if (p > hi) this.asks.delete(p);
  }
}
