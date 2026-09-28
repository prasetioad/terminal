import type { Listing } from "../venues";
import { makeTrade, safeJson, timeSideKey, type StreamSpec } from "./types";

/**
 * "trades" channel item: fills of one taker order at one price, already merged
 * by OKX (`count` fills). Swap sizes are in contracts; the listing's qtyScale
 * (ctVal × ctMult) converts them to base units.
 */
interface OkxTrade {
  instId: string;
  tradeId: string;
  px: string;
  sz: string;
  side: "buy" | "sell"; // taker side
  ts: string;
}

type Frame = { arg?: { channel: string; instId: string }; data?: OkxTrade[] };

export function okxStream(listing: Listing): StreamSpec {
  return {
    key: `${listing.source}:${listing.symbol}`,
    source: listing.source,
    urls: ["wss://ws.okx.com:8443/ws/v5/public"],
    subscribe: [JSON.stringify({ op: "subscribe", args: [{ channel: "trades", instId: listing.symbol }] })],
    // OKX drops connections that stay silent for 30s; it answers "ping" with a plain "pong".
    heartbeat: { intervalMs: 20_000, message: "ping" },
    parse(raw, emit) {
      const frame = safeJson<Frame>(raw);
      if (frame?.arg?.instId !== listing.symbol || !frame.data) return;
      for (const t of frame.data) {
        const side = t.side === "buy" ? "BUY" : "SELL";
        const time = Number(t.ts);
        const trade = makeTrade(listing, { id: t.tradeId, price: +t.px, qty: +t.sz, time, side });
        emit({ type: "trade", trade, orderKey: timeSideKey(time, side) });
      }
    },
  };
}
