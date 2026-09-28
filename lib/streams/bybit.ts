import type { Listing } from "../venues";
import { makeTrade, safeJson, timeSideKey, type StreamSpec } from "./types";

/** publicTrade item: one fill. */
interface BybitTrade {
  i: string; // trade id
  T: number; // fill time (ms)
  p: string;
  v: string; // size in the contract's base coin
  S: "Buy" | "Sell"; // taker side
  BT: boolean; // block trade: negotiated off-book, not aggression on the order book
}

type Frame = { topic?: string; data?: BybitTrade[] };

const ENDPOINTS = {
  spot: "wss://stream.bybit.com/v5/public/spot",
  perp: "wss://stream.bybit.com/v5/public/linear",
} as const;

export function bybitStream(listing: Listing, market: keyof typeof ENDPOINTS): StreamSpec {
  const topic = `publicTrade.${listing.symbol}`;
  return {
    key: `${listing.source}:${listing.symbol}`,
    source: listing.source,
    urls: [ENDPOINTS[market]],
    subscribe: [JSON.stringify({ op: "subscribe", args: [topic] })],
    heartbeat: { intervalMs: 20_000, message: JSON.stringify({ op: "ping" }) },
    parse(raw, emit) {
      const frame = safeJson<Frame>(raw);
      if (frame?.topic !== topic || !frame.data) return;
      for (const t of frame.data) {
        if (t.BT) continue;
        const side = t.S === "Buy" ? "BUY" : "SELL";
        const trade = makeTrade(listing, { id: t.i, price: +t.p, qty: +t.v, time: t.T, side });
        emit({ type: "trade", trade, orderKey: timeSideKey(t.T, side) });
      }
    },
  };
}
