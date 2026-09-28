import type { SourceId } from "./venues";
import type { Trade } from "./types";

const IDLE_FLUSH_MS = 40;

interface OpenCluster {
  key: string;
  trade: Trade;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Merges consecutive prints of one taker order into a single trade, so a market
 * order that sweeps several price levels (or is reported fill by fill) is judged
 * by its full size. Each source keeps at most one open cluster; it is emitted when
 * a print with a different order key arrives or after IDLE_FLUSH_MS of silence.
 */
export class TakerOrderClusterer {
  private readonly open = new Map<SourceId, OpenCluster>();

  constructor(private readonly emit: (trade: Trade) => void) {}

  push(trade: Trade, orderKey: string): void {
    const current = this.open.get(trade.source);
    if (current && current.key === orderKey) {
      current.trade = merge(current.trade, trade);
      clearTimeout(current.timer);
      current.timer = this.scheduleFlush(trade.source);
      return;
    }
    if (current) this.flush(trade.source);
    this.open.set(trade.source, { key: orderKey, trade, timer: this.scheduleFlush(trade.source) });
  }

  /** Drop every open cluster without emitting (e.g. on symbol change). */
  clear(): void {
    for (const cluster of this.open.values()) clearTimeout(cluster.timer);
    this.open.clear();
  }

  private scheduleFlush(source: SourceId) {
    return setTimeout(() => this.flush(source), IDLE_FLUSH_MS);
  }

  private flush(source: SourceId): void {
    const cluster = this.open.get(source);
    if (!cluster) return;
    clearTimeout(cluster.timer);
    this.open.delete(source);
    this.emit(cluster.trade);
  }
}

function merge(a: Trade, b: Trade): Trade {
  const qty = a.qty + b.qty;
  const usd = a.usd + b.usd;
  return {
    ...a,
    qty,
    usd,
    price: usd / qty, // volume-weighted average fill price
    fills: a.fills + b.fills,
  };
}
