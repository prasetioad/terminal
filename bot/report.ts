/**
 * The daily report: one Telegram message a day that says the bot is alive and how it is
 * doing — if it does not arrive, something is down. Also on demand with /report.
 *
 * Equity and its change, open positions with their result, the last 24 hours (entries,
 * exits, realized P&L, cycles run, errors), Binance's warnings, and — when COLLECTOR_DIR is
 * set — what the market-data collector recorded. Problems are flagged at the top.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { statusSnapshot } from "./api";
import { setupsName, type BotEngine } from "./engine";

const DAY = 86_400_000;
/** A 4h bot runs 6 cycles a day; fewer than this in 24h means it was down or failing. */
const MIN_CYCLES = 5;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
const pct = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r * 100).toFixed(2)}%`;

interface CollectorStats {
  liquidations: number;
  liquidatedUsd: number;
  depthRows: number;
  lastDepth: number | null;
}

/** What the collector stored in the last 24h (this month's and last month's files). */
function collectorStats(dir: string, now: number): CollectorStats | null {
  if (!fs.existsSync(dir)) return null;
  const months = [new Date(now).toISOString().slice(0, 7), new Date(now - DAY).toISOString().slice(0, 7)];
  const stats: CollectorStats = { liquidations: 0, liquidatedUsd: 0, depthRows: 0, lastDepth: null };
  let found = false;
  for (const month of new Set(months)) {
    const file = path.join(dir, `collector-${month}.sqlite`);
    if (!fs.existsSync(file)) continue;
    found = true;
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const l = db.prepare("SELECT count(*) n, coalesce(sum(quote), 0) usd FROM liquidations WHERE time >= ?").get(now - DAY) as { n: number; usd: number };
      const d = db.prepare("SELECT count(*) n, max(time) last FROM depth WHERE time >= ?").get(now - DAY) as { n: number; last: number | null };
      stats.liquidations += l.n;
      stats.liquidatedUsd += l.usd;
      stats.depthRows += d.n;
      if (d.last && (!stats.lastDepth || d.last > stats.lastDepth)) stats.lastDepth = d.last;
    } finally {
      db.close();
    }
  }
  return found ? stats : null;
}

export async function dailyReport(engine: BotEngine, nextRun: number | null, now = Date.now()): Promise<string> {
  const { store, cfg } = engine;
  const s = await statusSnapshot(engine, nextRun);
  const since = now - DAY;
  const flags: string[] = [];

  // Equity: now, 24h ago, since the start.
  const curve = store.equityCurve(1000);
  const before = [...curve].reverse().find((c) => c.time <= since) ?? curve[0];
  const day = before ? s.equity - before.equity : 0;
  const start = s.startEquity ?? curve[0]?.equity ?? s.equity;

  // The last 24 hours.
  const events = store.eventsSince(since);
  const cycles = events.filter((e) => e.kind === "cycle" && e.level === "info").length;
  const errors = events.filter((e) => e.level === "error");
  const all = [...store.openPositions(), ...store.closedPositions(1000)];
  const entries = all.filter((p) => p.openedAt >= since).length;
  const exits = store.closedPositions(1000).filter((p) => (p.closedAt ?? 0) >= since);
  const realized = exits.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  if (cycles < MIN_CYCLES) flags.push(`⚠️ only ${cycles} of 6 cycles ran in the last 24h`);
  if (errors.length) flags.push(`⚠️ ${errors.length} error(s) in the last 24h — last: ${esc(errors[errors.length - 1].message.slice(0, 120))}`);
  if (s.paused) flags.push("⏸ new entries are paused (/resume)");

  // Open positions.
  const open = await engine.openMarked();
  const openLines = open.map(({ position: p, price }) => {
    const r = price / p.entryPrice - 1;
    return `  · [${p.setup === "a" ? "A" : "v1"}] ${p.symbol} ${pct(r)} (${usd(p.qty * price - p.cost)} USDT) · stop ${p.stopPrice.toPrecision(5)}`;
  });

  // Binance's warnings.
  const risks = await engine.currentRisks();
  const delisting = [...risks.delist.keys()].filter((x) => x.endsWith("USDT"));
  const heldWarned = open.filter(({ position: p }) => risks.delist.has(p.symbol) || risks.monitoring.has(p.symbol)).map(({ position: p }) => p.symbol);
  if (!risks.fetchedAt) flags.push("⚠️ Binance's delist/Monitoring lists could not be read");
  if (heldWarned.length) flags.push(`🚩 held pair(s) with a Binance warning: ${heldWarned.join(", ")}`);

  // The collector.
  let collectorLine = "";
  const dir = process.env.COLLECTOR_DIR;
  if (dir) {
    const c = collectorStats(dir, now);
    if (!c) flags.push("⚠️ collector: no data files");
    else {
      const ago = c.lastDepth ? Math.round((now - c.lastDepth) / 60_000) : null;
      collectorLine = `Collector 24h: ${c.liquidations.toLocaleString("en-US")} liquidations (${(c.liquidatedUsd / 1e6).toFixed(1)}M USDT) · ${c.depthRows.toLocaleString("en-US")} depth rows · last ${ago === null ? "never" : `${ago} min ago`}`;
      if (ago === null || ago > 10) flags.push("⚠️ collector: no order-book snapshot in the last 10 minutes");
      if (c.liquidations === 0) flags.push("⚠️ collector: no liquidation in 24h (stream silent?)");
    }
  }

  return [
    `📋 <b>Daily report · ${esc(setupsName(cfg))} · ${cfg.mode.toUpperCase()}</b>`,
    ...(flags.length ? flags : ["✅ all systems normal"]),
    "",
    `Equity <b>${s.equity.toFixed(2)} USDT</b> · 24h ${usd(day)} · since start ${pct(start ? s.equity / start - 1 : 0)} · cash ${s.cash.toFixed(2)}`,
    `Open ${open.length} position(s)${openLines.length ? ":" : ""}`,
    ...openLines,
    `Last 24h: ${entries} entr${entries === 1 ? "y" : "ies"} · ${exits.length} exit(s) · realized ${usd(realized)} USDT · ${cycles} cycles · ${errors.length} errors`,
    `All time: ${s.closedTrades} closed trade(s)${s.winRate !== null ? ` · win ${(s.winRate * 100).toFixed(0)}% · avg ${pct(s.avgReturn!)}` : ""} · realized ${usd(s.totalPnl)} USDT`,
    `Binance warnings: ${delisting.length ? `delisting ${delisting.join(", ")}` : "no delisting"} · ${risks.monitoring.size} Monitoring`,
    ...(collectorLine ? [collectorLine] : []),
    s.nextRun ? `Next cycle ${new Date(s.nextRun).toISOString().slice(0, 16).replace("T", " ")} UTC` : "",
  ]
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n");
}
