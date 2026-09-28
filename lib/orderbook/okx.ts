import { safeJson, type StreamSpec } from "../streams/types";
import type { Listing } from "../venues";
import { SocketBook } from "./SocketBook";

/** [price, size, deprecated, order count]; swap sizes are contracts (listing.qtyScale converts). */
type OkxLevel = [string, string, string, string];

interface OkxBookEvent {
  action: "snapshot" | "update";
  seqId: number;
  prevSeqId: number;
  bids: OkxLevel[];
  asks: OkxLevel[];
}

/**
 * OKX `books` (400 levels): a snapshot on subscribe, then updates whose prevSeqId must
 * equal the previous seqId. (OKX no longer fills the checksum field, so sequence is the check.)
 */
export class OkxBook extends SocketBook<OkxBookEvent> {
  private lastSeq: number | null = null;

  constructor(listing: Listing) {
    super(listing, {
      key: `${listing.source}:${listing.symbol}:book`,
      source: listing.source,
      urls: ["wss://ws.okx.com:8443/ws/v5/public"],
      subscribe: [JSON.stringify({ op: "subscribe", args: [{ channel: "books", instId: listing.symbol }] })],
      heartbeat: { intervalMs: 20_000, message: "ping" },
      parse(raw, emit) {
        const m = safeJson<{ arg?: { instId: string }; action?: OkxBookEvent["action"]; data?: Omit<OkxBookEvent, "action">[] }>(raw);
        if (m?.arg?.instId !== listing.symbol || !m.action || !m.data) return;
        for (const d of m.data) emit({ action: m.action, ...d });
      },
    } satisfies StreamSpec<OkxBookEvent>);
  }

  protected onConnected(): void {
    this.live = false;
    this.lastSeq = null;
    this.book.clear();
  }

  protected onEvent(e: OkxBookEvent): void {
    if (e.action === "snapshot") {
      this.book.clear();
      this.applyLevels(e);
      this.lastSeq = e.seqId;
      this.live = true;
      return;
    }
    if (!this.live) return;
    if (e.prevSeqId !== this.lastSeq) {
      this.resubscribe();
      return;
    }
    this.applyLevels(e);
    this.lastSeq = e.seqId;
  }

  private applyLevels(e: OkxBookEvent): void {
    for (const [p, q] of e.bids) this.setLevel("bid", p, q);
    for (const [p, q] of e.asks) this.setLevel("ask", p, q);
  }
}
