/**
 * Robustness of the one value-area rule that held in- and out-of-sample (research/auction-refine.ts,
 * 4h profile → 1h): SHORT the breakdown below VAL whose retest holds, stop past the heaviest
 * volume node above, target 2R (B), optionally after three bars of selling (C). A short needs a
 * futures account, so here:
 *
 *   per R        return ÷ distance to the stop (sizing is by risk, so R is what compounds;
 *                a wider stop alone inflates % per trade)
 *   tradable     only while the coin had a USDT-M perpetual (research/futures.ts klines)
 *   funding      a short receives positive funding and pays negative, summed over the hold
 *   costs        futures taker 0.1% round trip (and maker 0.04%)
 *   concentration   per year, the 10 best coins' share, coins later delisted, a 1% trim
 *   portfolio    1% risk per trade, ≤ 10 open, compounding on closed trades
 *
 * The long mirror (VAH continuation, B) is shown for contrast.
 *
 *   npx tsx research/auction-refine.ts   (writes the trades)
 *   npx tsx research/auction-short.ts
 */
import fs from "node:fs";
import path from "node:path";
import { TRADES_FILE } from "./auction-refine";
import { CACHE_DIR } from "./data";
import { cachedFutures, type FuturesSeries } from "./futures";
import { pct } from "./momentum";

const SPLIT = Date.UTC(2024, 6, 1);
const RULES = [
  "4h → 1h · VAL continuation (short) · A TP 2R",
  "4h → 1h · VAL continuation (short) · B + SL at node",
  "4h → 1h · VAL continuation (short) · C + 3 delta",
  "4h → 1h · VAH continuation (long) · B + SL at node",
];

interface T {
  at: number;
  exitAt: number;
  gross: number;
  risk: number;
  symbol: string;
  reason: string;
}
interface X extends T {
  dir: 1 | -1;
  funding: number;
  net: number; // after taker cost and funding, as a share of the position
  r: number; // net in R
}

const futures = new Map<string, FuturesSeries | null>();
const fut = (s: string) => {
  if (!futures.has(s)) futures.set(s, cachedFutures(s));
  return futures.get(s) ?? null;
};
/** The last 1h bar of the spot pair: coins whose data ends early were delisted. */
const lastBar = new Map<string, number>();
function lastSpot(symbol: string): number {
  if (!lastBar.has(symbol)) {
    const file = path.join(CACHE_DIR, "klines", "1h", `${symbol}.json`);
    const bars = JSON.parse(fs.readFileSync(file, "utf8")) as { time: number }[];
    lastBar.set(symbol, bars[bars.length - 1].time * 1000);
  }
  return lastBar.get(symbol) ?? 0;
}

function enrich(t: T, dir: 1 | -1, cost: number): X | null {
  const f = fut(t.symbol);
  if (!f || !f.klines.t.length) return null;
  const from = f.klines.t[0] * 1000;
  const to = f.klines.t[f.klines.t.length - 1] * 1000 + 4 * 3_600_000;
  if (t.at < from || t.exitAt > to) return null;
  let funding = 0;
  for (const x of f.funding) if (x.t > t.at && x.t <= t.exitAt) funding += -dir * x.r; // a short (dir −1) receives +r
  const net = t.gross + funding - cost;
  return { ...t, dir, funding, net, r: net / t.risk };
}

function summary(xs: X[]) {
  if (!xs.length) return "–";
  const m = (f: (x: X) => number) => xs.reduce((a, x) => a + f(x), 0) / xs.length;
  const rs = xs.map((x) => x.r).sort((a, b) => a - b);
  const sd = Math.sqrt(rs.reduce((a, r) => a + (r - m((x) => x.r)) ** 2, 0) / Math.max(1, rs.length - 1));
  const cut = Math.floor(rs.length * 0.01);
  const trimmed = rs.slice(cut, rs.length - cut);
  const tm = trimmed.reduce((a, r) => a + r, 0) / trimmed.length;
  return `n ${String(xs.length).padStart(5)} · gross ${pct(m((x) => x.gross), 3)} · funding ${pct(m((x) => x.funding), 3)} · net ${pct(m((x) => x.net), 3)} · per R ${m((x) => x.r).toFixed(3)} (t ${((m((x) => x.r) / sd) * Math.sqrt(xs.length)).toFixed(1)}) · 1%-trimmed ${tm.toFixed(3)}R · median ${rs[Math.floor(rs.length / 2)].toFixed(2)}R · risk median ${pct(xs.map((x) => x.risk).sort((a, b) => a - b)[Math.floor(xs.length / 2)], 2)}`;
}

function portfolio(xs: X[], from: number, to: number) {
  const trades = xs.filter((x) => x.at >= from && x.at < to).sort((a, b) => a.at - b.at);
  let equity = 1;
  let peak = 1;
  let dd = 0;
  const open: { exitAt: number; pnl: number }[] = [];
  const settle = (until: number) => {
    open.sort((a, b) => a.exitAt - b.exitAt);
    while (open.length && open[0].exitAt <= until) {
      const o = open.shift();
      if (!o) break;
      equity += o.pnl;
      peak = Math.max(peak, equity);
      dd = Math.min(dd, equity / peak - 1);
    }
  };
  let taken = 0;
  for (const x of trades) {
    settle(x.at);
    if (open.length >= 10) continue;
    open.push({ exitAt: x.exitAt, pnl: equity * 0.01 * x.r });
    taken++;
  }
  settle(Number.POSITIVE_INFINITY);
  const years = (to - from) / (365.25 * 86_400_000);
  return `taken ${taken} · CAGR ${pct(equity ** (1 / years) - 1)} · max DD ${pct(dd)} · ×${equity.toFixed(2)}`;
}

function main() {
  const all: Record<string, T[]> = JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  const end = Date.UTC(2026, 9, 3);
  for (const rule of RULES) {
    const dir = rule.includes("(short)") ? -1 : 1;
    const raw = all[rule] ?? [];
    const xs = raw.map((t) => enrich(t, dir, 0.001)).filter((x): x is X => x !== null);
    const maker = raw.map((t) => enrich(t, dir, 0.0004)).filter((x): x is X => x !== null);
    console.log(`\n${rule}`);
    console.log(`  tradable on a perpetual: ${xs.length} of ${raw.length}`);
    console.log(`  IS  ${summary(xs.filter((x) => x.at < SPLIT))}`);
    console.log(`  OOS ${summary(xs.filter((x) => x.at >= SPLIT))}`);
    console.log(`  maker 0.04%: IS ${summary(maker.filter((x) => x.at < SPLIT)).split(" · ").slice(3, 5).join(" · ")} │ OOS ${summary(maker.filter((x) => x.at >= SPLIT)).split(" · ").slice(3, 5).join(" · ")}`);
    const years: string[] = [];
    for (let y = 2021; y <= 2026; y++) {
      const ys = xs.filter((x) => new Date(x.at).getUTCFullYear() === y);
      if (ys.length) years.push(`${y} ${(ys.reduce((a, x) => a + x.r, 0) / ys.length).toFixed(3)}R (${ys.length})`);
    }
    console.log(`  per year (net, R): ${years.join(" · ")}`);
    const bySym = new Map<string, number>();
    for (const x of xs) bySym.set(x.symbol, (bySym.get(x.symbol) ?? 0) + x.r);
    const total = xs.reduce((a, x) => a + x.r, 0);
    const top = [...bySym].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  coins ${bySym.size} · the 10 best give ${((100 * top.reduce((a, [, v]) => a + v, 0)) / total).toFixed(0)}% of the total R: ${top.map(([s, v]) => `${s.replace("USDT", "")} ${v.toFixed(0)}`).join(", ")}`);
    const delisted = (x: X) => lastSpot(x.symbol) < end - 30 * 86_400_000;
    console.log(`  still listed: ${summary(xs.filter((x) => !delisted(x)))}`);
    console.log(`  later delisted: ${summary(xs.filter(delisted))}`);
    console.log(`  portfolio (1% risk, ≤ 10 open, taker + funding): IS ${portfolio(xs, Date.UTC(2021, 0, 1), SPLIT)} │ OOS ${portfolio(xs, SPLIT, end)}`);
  }
}

if (process.argv[1]?.endsWith("auction-short.ts")) main();
