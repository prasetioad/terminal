import { safeJson, type StreamSpec } from "../streams/types";
import type { Listing } from "../venues";
import type { Level } from "./SnapshotDiffBook";
import { SocketBook } from "./SocketBook";

interface BybitBookEvent {
  type: "snapshot" | "delta";
  u: number; // update id: +1 per message; u = 1 means the service restarted (sent as a snapshot)
  b: Level[];
  a: Level[];
}

const ENDPOINTS = {
  spot: "wss://stream.bybit.com/v5/public/spot",
  perp: "wss://stream.bybit.com/v5/public/linear",
} as const;

/** Bybit v5 `orderbook.1000`: a snapshot on subscribe, then deltas with consecutive `u`. */
export class BybitBook extends SocketBook<BybitBookEvent> {
  private lastU: number | null = null;

  constructor(listing: Listing, market: keyof typeof ENDPOINTS) {
    const topic = `orderbook.1000.${listing.symbol}`;
    super(listing, {
      key: `${listing.source}:${listing.symbol}:book`,
      source: listing.source,
      urls: [ENDPOINTS[market]],
      subscribe: [JSON.stringify({ op: "subscribe", args: [topic] })],
      heartbeat: { intervalMs: 20_000, message: JSON.stringify({ op: "ping" }) },
      parse(raw, emit) {
        const m = safeJson<{ topic?: string; type?: BybitBookEvent["type"]; data?: Omit<BybitBookEvent, "type"> }>(raw);
        if (m?.topic === topic && m.type && m.data) emit({ type: m.type, ...m.data });
      },
    } satisfies StreamSpec<BybitBookEvent>);
  }

  protected onConnected(): void {
    this.live = false;
    this.lastU = null;
    this.book.clear(); // the subscription answers with a snapshot
  }

  protected onEvent(e: BybitBookEvent): void {
    if (e.type === "snapshot") {
      this.book.clear();
      this.applyLevels(e);
      this.lastU = e.u;
      this.live = true;
      return;
    }
    if (!this.live) return;
    if (e.u !== (this.lastU ?? 0) + 1) {
      this.resubscribe(); // only a new subscription yields a fresh snapshot
      return;
    }
    this.applyLevels(e);
    this.lastU = e.u;
  }

  private applyLevels(e: BybitBookEvent): void {
    for (const [p, q] of e.b) this.setLevel("bid", p, q);
    for (const [p, q] of e.a) this.setLevel("ask", p, q);
  }
}
