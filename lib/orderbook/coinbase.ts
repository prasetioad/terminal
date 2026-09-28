import { safeJson, type StreamSpec } from "../streams/types";
import type { Listing } from "../venues";
import { SocketBook } from "./SocketBook";

interface CoinbaseL2Update {
  side: "bid" | "offer";
  price_level: string;
  new_quantity: string;
}

/** Every message on the connection carries sequence_num (+1 each, across channels). */
interface CoinbaseBookEvent {
  seq: number;
  events: { type: "snapshot" | "update"; updates: CoinbaseL2Update[] }[];
}

/**
 * Coinbase Advanced Trade `level2` — public, unlike the Exchange feed's level2 (which now
 * requires auth). The snapshot is the whole book; `heartbeats` keep quiet products alive.
 */
export class CoinbaseBook extends SocketBook<CoinbaseBookEvent> {
  private lastSeq: number | null = null;

  constructor(listing: Listing) {
    const product_ids = [listing.symbol];
    super(listing, {
      key: `${listing.source}:${listing.symbol}:book`,
      source: listing.source,
      urls: ["wss://advanced-trade-ws.coinbase.com"],
      subscribe: [
        JSON.stringify({ type: "subscribe", product_ids, channel: "level2" }),
        JSON.stringify({ type: "subscribe", channel: "heartbeats" }),
      ],
      parse(raw, emit) {
        const m = safeJson<{ channel?: string; sequence_num?: number; events?: CoinbaseBookEvent["events"] }>(raw);
        if (typeof m?.sequence_num !== "number") return;
        emit({ seq: m.sequence_num, events: m.channel === "l2_data" && m.events ? m.events : [] });
      },
    } satisfies StreamSpec<CoinbaseBookEvent>);
  }

  protected onConnected(): void {
    this.live = false;
    this.lastSeq = null;
    this.book.clear();
  }

  protected onEvent(e: CoinbaseBookEvent): void {
    if (this.lastSeq !== null && e.seq !== this.lastSeq + 1) {
      this.resubscribe();
      return;
    }
    this.lastSeq = e.seq;
    for (const ev of e.events) {
      if (ev.type === "snapshot") {
        this.book.clear();
        this.live = true;
      } else if (!this.live) {
        continue;
      }
      for (const u of ev.updates) this.setLevel(u.side === "bid" ? "bid" : "ask", u.price_level, u.new_quantity);
    }
  }
}
