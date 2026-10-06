/**
 * Gemini's round-3 proposals (Discussion.md), rules exactly as written there, long spot only:
 *
 *   POST-FUNDING SQUEEZE  the 1h bar opening at a funding settlement (00/08/16 UTC) whose
 *     funding rate ≤ −0.03% / −0.05% / −0.08%; BTC's 4h return ≥ −2%; that bar's spot taker
 *     buy ratio > 0.5 → buy its close (01/09/17 UTC). Out 7 bars later (08/16/24 UTC) or at a
 *     disaster stop 2 × ATR14 (1h) under the entry. Spot ≥ $5M/day.
 *     Control: the same without the funding condition (every settlement bar).
 *   BASIS DISLOCATION  at a 4h close, perp ÷ spot − 1 ≤ −0.4% / −0.6% / −0.9% and open
 *     interest fell over the bar → buy the spot close. Out after 12h or 24h, earlier at a 4h
 *     close where the basis is back ≥ 0, or at a disaster stop 2 × ATR14 (4h). Spot ≥ $5M/day.
 *     Control: OI falling and basis < 0, no threshold.
 *
 * Judged per trade and per event (all trades entered in the same hour are one event).
 * In-sample 2021 → 2024-06, out-of-sample after.
 *
 *   npx tsx research/futures.ts   (data, once)
 *   npx tsx research/funding-basis.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, archiveSymbols, type ResearchBar } from "./data";
import { cachedFutures } from "./futures";
import { atr14, cell, prefix, stats, type Sample } from "./intraday-edge";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const H1 = 3_600_000;
const H4 = 4 * H1;
const SPLIT = Date.UTC(2024, 6, 1);
const MIN_LIQUIDITY = 5e6;

type Book = Map<string, Sample[]>;
const add = (book: Book, key: string, s: Sample) => {
  const list = book.get(key);
  if (list) list.push(s);
  else book.set(key, [s]);
};

const load = (interval: string, symbol: string): ResearchBar[] | null => {
  const file = path.join(CACHE_DIR, "klines", interval, `${symbol}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};

/** Index of each bar by open time (seconds). */
const indexOf = (c: ResearchBar[]) => new Map<number, number>(c.map((b, i) => [b.time, i]));

/** Daily spot volume over the 30 days before bar i (point in time). */
function liquidity(c: ResearchBar[], qv: number[], i: number, barMs: number) {
  const bars = Math.min(i, Math.round((30 * 86_400_000) / barMs));
  return bars ? ((qv[i] - qv[i - bars]) / bars) * (86_400_000 / barMs) : 0;
}

/** Hold from entry bar e: out at the close of bar e + hold, or at the stop; `early(x)` ends at a close. */
function hold(c: ResearchBar[], e: number, hold: number, stop: number, early?: (x: number) => boolean): number {
  const entry = c[e].close;
  const last = Math.min(c.length - 1, e + hold);
  for (let x = e + 1; x <= last; x++) {
    if (c[x].time - c[x - 1].time !== c[1].time - c[0].time) return c[x - 1].close / entry - 1; // a gap: out at the last price
    if (c[x].low <= stop) return Math.min(c[x].open, stop) / entry - 1;
    if (early?.(x)) return c[x].close / entry - 1;
  }
  return c[last].close / entry - 1;
}

function postFunding(symbol: string, btc: { c: ResearchBar[]; at: Map<number, number> }, book: Book) {
  const fut = cachedFutures(symbol);
  const c = load("1h", symbol);
  if (!fut || !c) return;
  const at = indexOf(c);
  const a = atr14(c);
  const qv = prefix(c.map((b) => b.quoteVolume));
  for (const f of fut.funding) {
    const t = Math.round(f.t / H1) * 3600; // settlement hour (payments are stamped a few ms late)
    if (![0, 8, 16].includes(new Date(t * 1000).getUTCHours())) continue;
    const i = at.get(t);
    if (i === undefined || i < 720 || i + 7 >= c.length || Number.isNaN(a[i])) continue;
    if (liquidity(c, qv, i, H1) < MIN_LIQUIDITY) continue;
    const bi = btc.at.get(t);
    if (bi === undefined || bi < 4 || btc.c[bi].close / btc.c[bi - 4].close - 1 < -0.02) continue;
    if (!(c[i].volume > 0 && (c[i].buyVolume ?? 0) / c[i].volume > 0.5)) continue;
    const s = { at: t * 1000 + H1, gross: hold(c, i, 7, c[i].close - 2 * a[i]) };
    add(book, "funding: control (every settlement)", s);
    for (const th of [-0.0003, -0.0005, -0.0008]) if (f.r <= th) add(book, `funding ≤ ${(th * 100).toFixed(2)}%`, s);
  }
}

function basis(symbol: string, book: Book) {
  const fut = cachedFutures(symbol);
  const c = load("4h", symbol);
  if (!fut || !c || fut.bars.t.length < 2) return;
  const perp = new Map(fut.klines.t.map((t, k) => [t, fut.klines.close[k] / fut.mult]));
  const oi = new Map(fut.bars.t.map((t, k) => [t, fut.bars.oi[k]]));
  const a = atr14(c);
  const qv = prefix(c.map((b) => b.quoteVolume));
  const basisAt = (x: number) => {
    const p = perp.get(c[x].time);
    return p === undefined ? Number.NaN : p / c[x].close - 1;
  };
  const busy = new Map<string, number>();
  for (let i = 180; i < c.length - 1; i++) {
    const b = basisAt(i);
    const o = oi.get(c[i].time);
    const o0 = oi.get(c[i].time - 14_400);
    if (!(b < 0) || o === undefined || o0 === undefined || !(o < o0)) continue;
    if (Number.isNaN(a[i]) || liquidity(c, qv, i, H4) < MIN_LIQUIDITY) continue;
    const stop = c[i].close - 2 * a[i];
    const early = (x: number) => basisAt(x) >= 0;
    for (const [label, th] of [["control (basis < 0)", 0], ["≤ −0.4%", -0.004], ["≤ −0.6%", -0.006], ["≤ −0.9%", -0.009]] as const) {
      if (th < 0 && b > th) continue;
      for (const bars of [3, 6]) {
        const key = `basis ${label} · ${bars * 4}h`;
        if ((busy.get(key) ?? -1) >= i) continue;
        busy.set(key, i + bars);
        add(book, key, { at: c[i].time * 1000 + H4, gross: hold(c, i, bars, stop, early) });
      }
    }
  }
}

async function main() {
  const btcBars = load("1h", "BTCUSDT");
  if (!btcBars) throw new Error("BTCUSDT 1h missing");
  const btc = { c: btcBars, at: indexOf(btcBars) };
  const book: Book = new Map();
  const symbols = (await archiveSymbols()).filter(inUniverse);
  for (const symbol of symbols) {
    postFunding(symbol, btc, book);
    basis(symbol, book);
  }
  console.log("Gemini round 3 · IS 2021 → 2024-06 │ OOS 2024-07 → now · spot ≥ $5M/day\n");
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    console.log(`  ${key.padEnd(34)} ${cell(xs.filter((t) => t.at < SPLIT))}`);
    console.log(`  ${"".padEnd(34)} ${cell(xs.filter((t) => t.at >= SPLIT))}`);
  }
  console.log("\nPER YEAR, gross per trade (n)");
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    const years: string[] = [];
    for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
      const s = stats(xs.filter((t) => new Date(t.at).getUTCFullYear() === y));
      years.push(s ? `${y} ${pct(s.g, 2)} (${s.n})` : `${y} –`);
    }
    console.log(`  ${key.padEnd(34)} ${years.join(" · ")}`);
  }
}

if (process.argv[1]?.endsWith("funding-basis.ts")) void main();
