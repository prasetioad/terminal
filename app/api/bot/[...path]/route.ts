import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Proxy to the bot's API (bot/api.ts), so its token never reaches the browser.
 * BOT_API_URL (default http://127.0.0.1:8787) and BOT_API_TOKEN come from the web
 * app's environment. Only the bot's own endpoints pass through.
 */
const READS = new Set(["status", "positions", "trades", "equity", "events"]);
const WRITES = new Set(["pause", "resume"]);

type Context = { params: Promise<{ path: string[] }> };

async function forward(method: "GET" | "POST", ctx: Context) {
  const path = (await ctx.params).path.join("/");
  if (!(method === "GET" ? READS : WRITES).has(path)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const base = process.env.BOT_API_URL ?? "http://127.0.0.1:8787";
  try {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: process.env.BOT_API_TOKEN ? { Authorization: `Bearer ${process.env.BOT_API_TOKEN}` } : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json(await res.json(), { status: res.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "bot unreachable", hint: "Start it with `npm run bot` (see docs/BOT.md)" }, { status: 503 });
  }
}

export const GET = (_req: NextRequest, ctx: Context) => forward("GET", ctx);
export const POST = (_req: NextRequest, ctx: Context) => forward("POST", ctx);
