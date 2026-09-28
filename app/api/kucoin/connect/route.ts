import { NextResponse, type NextRequest } from "next/server";

/**
 * KuCoin only accepts WebSocket connections carrying a short-lived public token
 * from POST /bullet-public (no API key involved). That endpoint sends no CORS
 * headers, so the browser gets its connect URL through this route instead.
 */
const BULLET_URLS = {
  spot: "https://api.kucoin.com/api/v1/bullet-public",
  perp: "https://api-futures.kucoin.com/api/v1/bullet-public",
} as const;

type Market = keyof typeof BULLET_URLS;

interface BulletResponse {
  code: string;
  data?: { token: string; instanceServers: { endpoint: string; protocol: string }[] };
}

const isMarket = (value: string | null): value is Market => value === "spot" || value === "perp";

export async function GET(request: NextRequest) {
  const market = request.nextUrl.searchParams.get("market");
  if (!isMarket(market)) {
    return NextResponse.json({ error: "market must be 'spot' or 'perp'" }, { status: 400 });
  }

  try {
    const res = await fetch(BULLET_URLS[market], {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const body = (await res.json()) as BulletResponse;
    const server = body.data?.instanceServers.find((s) => s.protocol === "websocket");
    if (!res.ok || body.code !== "200000" || !body.data || !server) throw new Error(`KuCoin bullet ${body.code}`);

    const url = `${server.endpoint}?token=${encodeURIComponent(body.data.token)}&connectId=${crypto.randomUUID()}`;
    return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "KuCoin token unavailable" }, { status: 502 });
  }
}
