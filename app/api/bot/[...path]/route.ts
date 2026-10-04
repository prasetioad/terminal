import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Proxy to the bots' API (bot/api.ts), so their token never reaches the browser.
 * `?bot=ops` reaches the operations bot (BOT_OPS_API_URL), otherwise the paper bot
 * (BOT_API_URL, default http://127.0.0.1:8787); BOT_API_TOKEN comes from the web app's
 * environment. Only the bot's own endpoints pass through.
 */
const READS = new Set(["status", "positions", "trades", "equity", "events"]);
const WRITES = new Set(["pause", "resume"]);

type Context = { params: Promise<{ path: string[] }> };

async function forward(method: "GET" | "POST", req: NextRequest, ctx: Context) {
  const path = (await ctx.params).path.join("/");
  if (!(method === "GET" ? READS : WRITES).has(path)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ops = req.nextUrl.searchParams.get("bot") === "ops";
  const base = ops ? process.env.BOT_OPS_API_URL : (process.env.BOT_API_URL ?? "http://127.0.0.1:8787");
  if (!base) return NextResponse.json({ error: "ops bot not configured", hint: "Set BOT_OPS_API_URL (docs/BOT.md)" }, { status: 503 });
  try {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: process.env.BOT_API_TOKEN ? { Authorization: `Bearer ${process.env.BOT_API_TOKEN}` } : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json(await res.json(), { status: res.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: ops ? "ops bot unreachable" : "bot unreachable", hint: "Start it with `npm run bot` (see docs/BOT.md)" }, { status: 503 });
  }
}

export const GET = (req: NextRequest, ctx: Context) => forward("GET", req, ctx);
export const POST = (req: NextRequest, ctx: Context) => forward("POST", req, ctx);
