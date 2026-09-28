import { resolveKucoinConnectUrl } from "../streams/kucoin";
import { safeJson, type StreamSpec } from "../streams/types";
import type { Listing } from "../venues";
import { SnapshotDiffBook, type BookSnapshot, type Verdict } from "./SnapshotDiffBook";

type Market = "spot" | "perp";

/**
 * Spot  `/market/level2`: changes carry per-level sequences; messages span
 *        [sequenceStart, sequenceEnd], consecutive across messages.
 * Perp  `/contractMarket/level2`: one change per message, `sequence` +1 each.
 */
interface KucoinBookEvent {
  start: number;
  end: number;
  changes: { side: "bid" | "ask"; price: string; size: string; seq: number }[];
}

const TOPICS = {
  spot: (symbol: string) => `/market/level2:${symbol}`,
  perp: (symbol: string) => `/contractMarket/level2:${symbol}`,
} as const;

function bookStream(listing: Listing, market: Market): StreamSpec<KucoinBookEvent> {
  const topic = TOPICS[market](listing.symbol);
  return {
    key: `${listing.source}:${listing.symbol}:book`,
    source: listing.source,
    resolveUrl: (signal) => resolveKucoinConnectUrl(market, signal),
    subscribe: [JSON.stringify({ id: "book", type: "subscribe", topic, privateChannel: false, response: true })],
    heartbeat: { intervalMs: 15_000, message: JSON.stringify({ id: "ping", type: "ping" }) },
    parse(raw, emit) {
      const m = safeJson<{ type?: string; topic?: string; data?: Record<string, unknown> }>(raw);
      if (m?.type !== "message" || m.topic !== topic || !m.data) return;
      if (market === "spot") {
        const d = m.data as { sequenceStart: number; sequenceEnd: number; changes: { asks: string[][]; bids: string[][] } };
        const changes = [
          ...d.changes.bids.map(([price, size, seq]) => ({ side: "bid" as const, price, size, seq: Number(seq) })),
          ...d.changes.asks.map(([price, size, seq]) => ({ side: "ask" as const, price, size, seq: Number(seq) })),
        ];
        emit({ start: d.sequenceStart, end: d.sequenceEnd, changes });
      } else {
        const d = m.data as { sequence: number; change: string };
        const [price, side, size] = d.change.split(",");
        emit({ start: d.sequence, end: d.sequence, changes: [{ side: side === "buy" ? "bid" : "ask", price, size, seq: d.sequence }] });
      }
    },
  };
}

/** KuCoin book: public REST snapshot (via our server route: no CORS upstream) + sequenced diffs. */
export class KucoinBook extends SnapshotDiffBook<KucoinBookEvent> {
  constructor(
    listing: Listing,
    private readonly market: Market,
  ) {
    super(listing, bookStream(listing, market));
  }

  protected async fetchSnapshot(signal: AbortSignal): Promise<BookSnapshot> {
    const res = await fetch(`/api/kucoin/book?market=${this.market}&symbol=${encodeURIComponent(this.listing.symbol)}`, {
      signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`KuCoin snapshot ${res.status}`);
    return (await res.json()) as BookSnapshot;
  }

  protected accept(e: KucoinBookEvent, lastId: number | null, snapshotId: number): Verdict {
    if (lastId === null) {
      if (e.end <= snapshotId) return "skip";
      return e.start <= snapshotId + 1 ? "ok" : "gap";
    }
    return e.start === lastId + 1 ? "ok" : "gap";
  }

  protected applyEvent(e: KucoinBookEvent, snapshotId: number): void {
    for (const c of e.changes) {
      if (c.seq <= snapshotId || Number(c.price) === 0) continue; // already in the snapshot / sequence-only marker
      this.setLevel(c.side, c.price, c.size);
    }
  }

  protected lastIdOf(e: KucoinBookEvent): number {
    return e.end;
  }
}
