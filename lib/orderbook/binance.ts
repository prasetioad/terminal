import { fetchBinanceJson } from "../binance";
import { safeJson, type StreamSpec } from "../streams/types";
import type { Listing } from "../venues";
import { SnapshotDiffBook, type BookSnapshot, type Level, type Verdict } from "./SnapshotDiffBook";

/** A diff-depth event: every level that changed between update ids U and u. */
export interface DepthEvent {
  U: number; // first update id in the event
  u: number; // final update id in the event
  pu?: number; // futures only: `u` of the previous event
  b: Level[];
  a: Level[];
}

type Market = "spot" | "perp";

/** Diff-depth stream (100 ms). Futures order-book streams live under /public. */
function depthStream(listing: Listing, market: Market): StreamSpec<DepthEvent> {
  const s = encodeURIComponent(listing.symbol.toLowerCase());
  const query = `?streams=${s}@depth@100ms`;
  return {
    key: `${listing.source}:${listing.symbol}:depth`,
    source: listing.source,
    urls:
      market === "spot"
        ? [`wss://stream.binance.com:9443/stream${query}`, `wss://data-stream.binance.vision/stream${query}`]
        : [`wss://fstream.binance.com/public/stream${query}`],
    parse(raw, emit) {
      const data = safeJson<{ data?: DepthEvent & { e?: string } }>(raw)?.data;
      if (data?.e === "depthUpdate") emit(data);
    },
  };
}

/**
 * Binance's documented sync rules:
 *  spot : first diff has U ≤ lastUpdateId+1 ≤ u;  then U = previous u + 1
 *  perp : first diff has U ≤ lastUpdateId ≤ u;    then pu = previous u
 */
export class BinanceBook extends SnapshotDiffBook<DepthEvent> {
  constructor(
    listing: Listing,
    private readonly market: Market,
  ) {
    super(listing, depthStream(listing, market));
  }

  protected async fetchSnapshot(signal: AbortSignal): Promise<BookSnapshot> {
    type Raw = { lastUpdateId: number; bids: Level[]; asks: Level[] };
    const raw =
      this.market === "spot"
        ? await fetchBinanceJson<Raw>(`/api/v3/depth?symbol=${this.listing.symbol}&limit=5000`, signal, 10_000)
        : await fetchPerpSnapshot(this.listing.symbol, signal);
    return { id: raw.lastUpdateId, bids: raw.bids, asks: raw.asks };
  }

  protected accept(e: DepthEvent, lastId: number | null, snapshotId: number): Verdict {
    if (lastId === null) {
      const target = this.market === "spot" ? snapshotId + 1 : snapshotId;
      if (e.u < target) return "skip"; // already in the snapshot
      return e.U <= target ? "ok" : "gap";
    }
    const continuous = this.market === "spot" ? e.U === lastId + 1 : e.pu === lastId;
    return continuous ? "ok" : "gap";
  }

  protected applyEvent(e: DepthEvent): void {
    for (const [p, q] of e.b) this.setLevel("bid", p, q);
    for (const [p, q] of e.a) this.setLevel("ask", p, q);
  }

  protected lastIdOf(e: DepthEvent): number {
    return e.u;
  }
}

async function fetchPerpSnapshot(symbol: string, signal: AbortSignal) {
  const res = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=1000`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from fapi.binance.com`);
  return (await res.json()) as { lastUpdateId: number; bids: Level[]; asks: Level[] };
}
