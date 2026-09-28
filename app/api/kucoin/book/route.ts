import { NextResponse, type NextRequest } from "next/server";

/**
 * Public KuCoin order-book snapshot, normalised to { id, bids, asks }. KuCoin's REST API
 * sends no CORS headers, so the browser (and the heatmap worker) fetch it through here.
 * Spot: top 100 levels (the full book needs an API key); futures: the full public snapshot.
 */
const SNAPSHOT_URLS = {
  spot: (symbol: string) => `https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${symbol}`,
  perp: (symbol: string) => `https://api-futures.kucoin.com/api/v1/level2/snapshot?symbol=${symbol}`,
} as const;

type Market = keyof typeof SNAPSHOT_URLS;

interface KucoinSnapshot {
  code: string;
  data?: { sequence: string | number; bids: (string | number)[][]; asks: (string | number)[][] };
}

export async function GET(request: NextRequest) {
  const market = request.nextUrl.searchParams.get("market");
  const symbol = request.nextUrl.searchParams.get("symbol") ?? "";
  if ((market !== "spot" && market !== "perp") || !/^[A-Z0-9-]{2,30}$/.test(symbol)) {
    return NextResponse.json({ error: "market must be spot|perp and symbol a KuCoin symbol" }, { status: 400 });
  }

  try {
    const res = await fetch(SNAPSHOT_URLS[market as Market](symbol), { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    const body = (await res.json()) as KucoinSnapshot;
    if (!res.ok || body.code !== "200000" || !body.data) throw new Error(`KuCoin ${body.code}`);
    const { sequence, bids, asks } = body.data;
    return NextResponse.json({ id: Number(sequence), bids, asks }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "KuCoin snapshot unavailable" }, { status: 502 });
  }
}
