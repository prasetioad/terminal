/**
 * Market-data collector: records what Binance's archive does not keep, for research to
 * test later (docs/ROADMAP.md, Tahap 7 F6).
 *
 *   liquidations  every forced order on Binance USDT-M futures, from the public stream
 *                 !forceOrder@arr (Binance sends at most the latest one per symbol per second,
 *                 so cascades are undercounted — their shape still shows)
 *   depth         once a minute, the spot order book of the most liquid USDT pairs, summed in
 *                 bands around the mid (±0.25%, 0.5%, 1%, 2%, 5%, in USDT), plus the spread
 *                 and how far the levels reach (500 levels; 5000 for the 4 most liquid pairs,
 *                 whose books are too dense for 500 to leave the first 0.25%)
 *
 * Public data only, no API key. One SQLite file per month in COLLECTOR_DIR (default
 * collector/data). Reconnects on its own; logs a summary every hour.
 *
 *   NODE_OPTIONS=--experimental-websocket npx tsx collector/main.ts
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DIR = process.env.COLLECTOR_DIR ?? "collector/data";
const DEPTH_PAIRS = Number(process.env.COLLECTOR_DEPTH_PAIRS ?? 40);
/** The deepest books (BTC, ETH, …) need 5000 levels to reach ±1–5%; capped to keep the IP's weight budget for the bots. */
const DEEP_PAIRS = 4;
const DEPTH_HOST = "https://data-api.binance.vision";
// Binance serves futures market streams under /market/ws (the legacy /ws path connects but stays silent).
const LIQ_STREAM = "wss://fstream.binance.com/market/ws/!forceOrder@arr";
const BANDS = [0.0025, 0.005, 0.01, 0.02, 0.05] as const;
/** Spot pairs that only mirror another price: no order book worth recording. */
const PEGGED = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "EURI", "AEUR", "WBTC", "WBETH", "BNSOL", "USD1", "XUSD", "BFUSD", "USDE", "RLUSD", "U", "PAXG"]);

/* ───────────────────────────── storage ───────────────────────────── */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS liquidations (time INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, qty REAL NOT NULL, quote REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS liquidations_time ON liquidations (time);
  CREATE TABLE IF NOT EXISTS depth (
    time INTEGER NOT NULL, symbol TEXT NOT NULL, mid REAL NOT NULL, spread REAL NOT NULL,
    bid025 REAL, bid05 REAL, bid1 REAL, bid2 REAL, bid5 REAL,
    ask025 REAL, ask05 REAL, ask1 REAL, ask2 REAL, ask5 REAL,
    reach_bid REAL NOT NULL, reach_ask REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS depth_time ON depth (time);`;

let current: { month: string; db: Database.Database } | null = null;
function db(time: number): Database.Database {
  const month = new Date(time).toISOString().slice(0, 7);
  if (current?.month === month) return current.db;
  current?.db.close();
  fs.mkdirSync(DIR, { recursive: true });
  const d = new Database(path.join(DIR, `collector-${month}.sqlite`));
  d.pragma("journal_mode = WAL");
  d.exec(SCHEMA);
  current = { month, db: d };
  return d;
}

const counts = { liquidations: 0, liquidatedUsd: 0, depth: 0, depthErrors: 0, reconnects: 0 };

/* ───────────────────────────── liquidations ───────────────────────────── */

interface ForceOrder {
  o: { s: string; S: "BUY" | "SELL"; ap: string; z: string; T: number };
}

let pending: [number, string, string, number, number, number][] = [];
function flushLiquidations() {
  if (!pending.length) return;
  const rows = pending;
  pending = [];
  // Rows go to the file of their own month (a month boundary only ever splits one batch).
  for (const month of new Set(rows.map((r) => new Date(r[0]).toISOString().slice(0, 7)))) {
    const batch = rows.filter((r) => new Date(r[0]).toISOString().slice(0, 7) === month);
    const d = db(batch[0][0]);
    const insert = d.prepare("INSERT INTO liquidations (time, symbol, side, price, qty, quote) VALUES (?, ?, ?, ?, ?, ?)");
    d.transaction(() => {
      for (const r of batch) insert.run(...r);
    })();
  }
}

function liquidationStream(stop: AbortSignal) {
  let backoff = 1000;
  const connect = () => {
    if (stop.aborted) return;
    const ws = new WebSocket(LIQ_STREAM);
    ws.onopen = () => {
      if (backoff > 1000 || counts.reconnects === 0) console.log("[collector] liquidation stream connected");
      backoff = 1000;
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as ForceOrder;
        const price = Number(m.o.ap);
        const qty = Number(m.o.z);
        // A SELL forced order closes a long (longs liquidated); a BUY closes a short.
        pending.push([m.o.T, m.o.s, m.o.S === "SELL" ? "long" : "short", price, qty, price * qty]);
        counts.liquidations++;
        counts.liquidatedUsd += price * qty;
      } catch {
        // a malformed frame is skipped
      }
    };
    ws.onclose = (ev) => {
      if (stop.aborted) return;
      console.log(`[collector] liquidation stream closed (${ev.code}) — reconnecting in ${backoff / 1000}s`);
      counts.reconnects++;
      setTimeout(connect, backoff);
      backoff = Math.min(60_000, backoff * 2);
    };
    ws.onerror = () => ws.close();
    stop.addEventListener("abort", () => ws.close(), { once: true });
  };
  connect();
}

/* ───────────────────────────── depth ───────────────────────────── */

let pairs: string[] = [];
let pairsAt = 0;
async function depthPairs(): Promise<string[]> {
  if (pairs.length && Date.now() - pairsAt < 24 * 3_600_000) return pairs;
  const res = await fetch(`${DEPTH_HOST}/api/v3/ticker/24hr`, { signal: AbortSignal.timeout(20_000) });
  const all = (await res.json()) as { symbol: string; quoteVolume: string }[];
  pairs = all
    .filter((t) => t.symbol.endsWith("USDT") && !PEGGED.has(t.symbol.slice(0, -4)) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, DEPTH_PAIRS)
    .map((t) => t.symbol);
  pairsAt = Date.now();
  return pairs;
}

/** USDT resting within each band of the mid, on one side. */
function bands(levels: [string, string][], mid: number, side: 1 | -1) {
  const sums = BANDS.map(() => 0);
  let reach = 0;
  for (const [p, q] of levels) {
    const price = Number(p);
    const dist = (side * (price - mid)) / mid;
    reach = Math.max(reach, dist);
    BANDS.forEach((b, i) => {
      if (dist <= b) sums[i] += price * Number(q);
    });
  }
  // a band beyond the levels' reach is unknown, not small
  return { sums: sums.map((s, i) => (BANDS[i] <= reach ? s : null)), reach };
}

async function depthRound() {
  const time = Math.floor(Date.now() / 60_000) * 60_000;
  const list = await depthPairs().catch(() => pairs);
  const rows: unknown[][] = [];
  for (const [rank, symbol] of list.entries()) {
    try {
      const res = await fetch(`${DEPTH_HOST}/api/v3/depth?symbol=${symbol}&limit=${rank < DEEP_PAIRS ? 5000 : 500}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // the bots share this IP's weight budget: back off before it gets tight
      if (Number(res.headers.get("x-mbx-used-weight-1m") ?? 0) > 3000) break;
      const book = (await res.json()) as { bids: [string, string][]; asks: [string, string][] };
      if (!book.bids.length || !book.asks.length) continue;
      const bestBid = Number(book.bids[0][0]);
      const bestAsk = Number(book.asks[0][0]);
      const mid = (bestBid + bestAsk) / 2;
      const b = bands(book.bids, mid, -1);
      const a = bands(book.asks, mid, 1);
      rows.push([time, symbol, mid, (bestAsk - bestBid) / mid, ...b.sums, ...a.sums, b.reach, a.reach]);
    } catch {
      counts.depthErrors++;
    }
  }
  if (!rows.length) return;
  const d = db(time);
  const insert = d.prepare(
    "INSERT INTO depth (time, symbol, mid, spread, bid025, bid05, bid1, bid2, bid5, ask025, ask05, ask1, ask2, ask5, reach_bid, reach_ask) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  d.transaction(() => {
    for (const r of rows) insert.run(...r);
  })();
  counts.depth += rows.length;
}

/* ───────────────────────────── main ───────────────────────────── */

function main() {
  if (typeof WebSocket === "undefined") throw new Error("WebSocket missing: run with NODE_OPTIONS=--experimental-websocket (Node 20)");
  const stop = new AbortController();
  liquidationStream(stop.signal);
  const flush = setInterval(flushLiquidations, 10_000);
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    depthRound().finally(() => (running = false));
  };
  // depth at the top of every minute
  const align = setTimeout(() => {
    tick();
    setInterval(tick, 60_000);
  }, 60_000 - (Date.now() % 60_000));
  const report = setInterval(() => {
    console.log(
      `[collector] last hour: ${counts.liquidations} liquidations (${(counts.liquidatedUsd / 1e6).toFixed(2)}M USDT) · ${counts.depth} depth rows (${pairs.length} pairs) · ${counts.depthErrors} depth errors · ${counts.reconnects} reconnects`,
    );
    Object.assign(counts, { liquidations: 0, liquidatedUsd: 0, depth: 0, depthErrors: 0, reconnects: 0 });
  }, 3_600_000);
  const shutdown = () => {
    stop.abort();
    clearInterval(flush);
    clearInterval(report);
    clearTimeout(align);
    flushLiquidations();
    current?.db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`[collector] liquidations (all USDT-M futures) + depth of the top ${DEPTH_PAIRS} spot pairs every minute → ${DIR}`);
}

main();
