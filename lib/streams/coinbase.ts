import type { Listing } from "../venues";
import { makeTrade, safeJson, type StreamSpec } from "./types";

/** "match": one fill between a resting maker order and a taker order. */
interface CoinbaseMatch {
  type: "match";
  trade_id: number;
  taker_order_id: string;
  side: "buy" | "sell"; // side of the MAKER order
  size: string;
  price: string;
  time: string; // ISO 8601
}

type Frame = { type?: string };

export function coinbaseStream(listing: Listing): StreamSpec {
  return {
    key: `${listing.source}:${listing.symbol}`,
    source: listing.source,
    urls: ["wss://ws-feed.exchange.coinbase.com"],
    // The heartbeat channel sends one message per second, keeping quiet products alive.
    subscribe: [JSON.stringify({ type: "subscribe", product_ids: [listing.symbol], channels: ["matches", "heartbeat"] })],
    parse(raw, emit) {
      // "last_match" replays the previous trade on subscribe; only live matches count.
      const frame = safeJson<Frame>(raw);
      if (frame?.type !== "match") return;
      const m = frame as CoinbaseMatch;
      // `side` is the maker's side, so the aggressor is on the opposite side.
      const side = m.side === "buy" ? "SELL" : "BUY";
      const trade = makeTrade(listing, {
        id: m.trade_id,
        price: +m.price,
        qty: +m.size,
        time: Date.parse(m.time),
        side,
      });
      // Coinbase exposes the taker order id, so fills can be grouped exactly.
      emit({ type: "trade", trade, orderKey: m.taker_order_id });
    },
  };
}
