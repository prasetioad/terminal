import type { Listing } from "../venues";
import { makeTrade, safeJson, type StreamSpec } from "./types";

/**
 * One fill. `side` is the taker side (verified against the live best bid/ask).
 * Spot sizes are base units; futures sizes are lots, which the listing's
 * qtyScale (multiplier × bundle) converts to base units.
 */
interface KucoinMatch {
  tradeId: string;
  takerOrderId: string;
  side: "buy" | "sell";
  price: string;
  size: string | number;
  time?: string; // spot: ns since epoch
  ts?: number; // futures: ns since epoch
}

type Frame = { type?: string; topic?: string; data?: KucoinMatch };

const TOPICS = {
  spot: (symbol: string) => `/market/match:${symbol}`,
  perp: (symbol: string) => `/contractMarket/execution:${symbol}`,
} as const;

type Market = keyof typeof TOPICS;

/** Every connect needs a fresh token, fetched server-side (the token endpoint has no CORS). */
export async function resolveKucoinConnectUrl(market: Market, signal: AbortSignal): Promise<string> {
  const res = await fetch(`/api/kucoin/connect?market=${market}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`KuCoin connect ${res.status}`);
  return ((await res.json()) as { url: string }).url;
}

const nsToMs = (ns: string | number) => Math.floor(Number(ns) / 1e6);

export function kucoinStream(listing: Listing, market: Market): StreamSpec {
  const topic = TOPICS[market](listing.symbol);
  return {
    key: `${listing.source}:${listing.symbol}`,
    source: listing.source,
    resolveUrl: (signal) => resolveKucoinConnectUrl(market, signal),
    subscribe: [JSON.stringify({ id: "sub", type: "subscribe", topic, privateChannel: false, response: true })],
    // KuCoin expects a ping within its 18s pingInterval; the pong also keeps quiet feeds alive.
    heartbeat: { intervalMs: 15_000, message: JSON.stringify({ id: "ping", type: "ping" }) },
    parse(raw, emit) {
      const frame = safeJson<Frame>(raw);
      if (frame?.type !== "message" || frame.topic !== topic || !frame.data) return;
      const m = frame.data;
      const ns = m.time ?? m.ts;
      if (ns === undefined) return;
      const side = m.side === "buy" ? "BUY" : "SELL";
      const trade = makeTrade(listing, {
        id: m.tradeId,
        price: +m.price,
        qty: +m.size,
        time: nsToMs(ns),
        side,
      });
      // KuCoin exposes the taker order id, so fills can be grouped exactly.
      emit({ type: "trade", trade, orderKey: m.takerOrderId });
    },
  };
}
