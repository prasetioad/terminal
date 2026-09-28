import type { UTCTimestamp } from "lightweight-charts";
import type { Candle, Trade } from "./types";

/**
 * Builds OHLCV bars from a chronological trade stream and tracks which bars
 * changed since the chart last pulled them. aggTrades arrive in order, so only
 * the last bar or a new bar can ever change.
 */
export class CandleAggregator {
  private bars: Candle[] = [];
  private intervalMs: number;
  private dirtyFrom = Number.POSITIVE_INFINITY;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  get candles(): readonly Candle[] {
    return this.bars;
  }

  /** Start a new dataset (new symbol or timeframe), optionally seeded with history. */
  reset(intervalMs: number, seed: Candle[] = []): void {
    this.intervalMs = intervalMs;
    this.bars = seed;
    this.dirtyFrom = Number.POSITIVE_INFINITY;
  }

  apply(trade: Trade): void {
    const bucket = (Math.floor(trade.time / this.intervalMs) * this.intervalMs) / 1000;
    const last = this.bars[this.bars.length - 1];

    if (!last || bucket > last.time) {
      // Binance opens a kline at its first trade, not at the previous close.
      this.bars.push({
        time: bucket as UTCTimestamp,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.qty,
        buyVolume: trade.side === "BUY" ? trade.qty : 0,
      });
    } else if (bucket === last.time) {
      last.high = Math.max(last.high, trade.price);
      last.low = Math.min(last.low, trade.price);
      last.close = trade.price;
      last.volume += trade.qty;
      if (trade.side === "BUY") last.buyVolume += trade.qty;
    } else {
      return; // late print for an already-closed bar
    }
    this.dirtyFrom = Math.min(this.dirtyFrom, this.bars.length - 1);
  }

  /** Index of the first bar changed since the last call, or null if nothing changed. */
  takeDirtyFrom(): number | null {
    const from = this.dirtyFrom;
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    return from === Number.POSITIVE_INFINITY ? null : from;
  }

  /** Drop the oldest bars once the history exceeds `max + slack`. Returns true if it trimmed. */
  trim(max: number, slack: number): boolean {
    if (this.bars.length <= max + slack) return false;
    this.bars.splice(0, this.bars.length - max);
    this.dirtyFrom = Number.POSITIVE_INFINITY; // the caller re-sends the whole series
    return true;
  }
}
