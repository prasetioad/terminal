/**
 * Gemini's round-5 proposal (Discussion.md): new Binance spot listings, on 1h candles from a
 * pair's first traded hour. Rules as written there, long only:
 *
 *   ORB-4h       H4 = the high of hours 0–3. The first close above H4 in hours 4–23, on volume
 *                > 1.2× the average of hours 0–3 → buy that close. Stop 3% under H4; out after
 *                12h, or at a trailing stop (highest close − 2 × ATR) once it is higher.
 *   H2 follow    hour 0 closes green and hour 1 closes above hour 0's high → buy hour 1's close.
 *                Stop at hour 0's low; out at hour 7's close.
 *   D1 breakout  H24 = the high of hours 0–23. The first close above H24 in hours 24–71 → buy.
 *                Stop 4% under H24; out after 24h, or at the 2 × ATR trailing stop.
 *   control      buy hour 0's close; hold 24h / 72h (how listings drift).
 *
 * A listing: a pair whose first 1h bar comes after the archive's start (2021-01-02), with ≥ $10M
 * traded in its first 24h. ATR is Wilder's over the bars so far (fewer than 14 early on).
 * In-sample 2021 → 2024-06, out-of-sample after.
 *
 *   npx tsx research/listing.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, archiveSymbols, type ResearchBar } from "./data";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const H1 = 3_600_000;
const SPLIT = Date.UTC(2024, 6, 1);
const ARCHIVE_START = Date.UTC(2021, 0, 2) / 1000;

interface Row {
  symbol: string;
  at: number;
  gross: number;
}

/** Wilder ATR over the bars so far (a plain mean until 14 bars exist). */
function atr(c: ResearchBar[]): number[] {
  const out = [c[0].high - c[0].low];
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    const n = Math.min(i + 1, 14);
    out.push((out[i - 1] * (n - 1) + tr) / n);
  }
  return out;
}

/** From entry bar e: the stop, then the trailing stop (highest close − 2 ATR), out at the close of bar `last`. */
function run(c: ResearchBar[], a: number[], e: number, stop0: number, last: number, trail: boolean): number {
  const entry = c[e].close;
  let stop = stop0;
  let best = entry;
  const end = Math.min(c.length - 1, last);
  for (let x = e + 1; x <= end; x++) {
    if (c[x].low <= stop) return Math.min(c[x].open, stop) / entry - 1;
    best = Math.max(best, c[x].close);
    if (trail) stop = Math.max(stop, best - 2 * a[x]);
  }
  return c[end].close / entry - 1;
}

async function main() {
  const book = new Map<string, Row[]>();
  const add = (key: string, r: Row) => book.set(key, [...(book.get(key) ?? []), r]);
  let listings = 0;
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", "1h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    const c: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    if (c.length < 100 || c[0].time < ARCHIVE_START) continue;
    // the first 72 hours must be contiguous
    if (c[72].time - c[0].time !== 72 * 3600) continue;
    let v24 = 0;
    for (let i = 0; i < 24; i++) v24 += c[i].quoteVolume;
    if (v24 < 10e6) continue;
    listings++;
    const a = atr(c);
    const at = (e: number) => c[e].time * 1000 + H1;

    add("control: hour 0 close · 24h", { symbol, at: at(0), gross: c[24].close / c[0].close - 1 });
    add("control: hour 0 close · 72h", { symbol, at: at(0), gross: c[72].close / c[0].close - 1 });

    const h4 = Math.max(c[0].high, c[1].high, c[2].high, c[3].high);
    const v4 = (c[0].volume + c[1].volume + c[2].volume + c[3].volume) / 4;
    for (let e = 4; e <= 23; e++) {
      if (c[e].close > h4 && c[e].volume > 1.2 * v4) {
        add("ORB-4h", { symbol, at: at(e), gross: run(c, a, e, h4 * 0.97, e + 12, true) });
        break;
      }
    }

    if (c[0].close > c[0].open && c[1].close > c[0].high) add("H2 follow-through", { symbol, at: at(1), gross: run(c, a, 1, c[0].low, 7, false) });

    let h24 = 0;
    for (let i = 0; i < 24; i++) h24 = Math.max(h24, c[i].high);
    for (let e = 24; e <= 71; e++) {
      if (c[e].close > h24) {
        add("D1 breakout", { symbol, at: at(e), gross: run(c, a, e, h24 * 0.96, e + 24, true) });
        break;
      }
    }
  }

  console.log(`${listings} listings since 2021 with ≥ $10M in the first 24h · IS → 2024-06 │ OOS after\n`);
  const line = (xs: Row[]) => {
    if (!xs.length) return "–";
    const g = xs.reduce((s, r) => s + r.gross, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, r) => s + (r.gross - g) ** 2, 0) / Math.max(1, xs.length - 1));
    const sorted = xs.map((r) => r.gross).sort((p, q) => p - q);
    const med = sorted[Math.floor(sorted.length / 2)];
    const win = xs.filter((r) => r.gross > 0.002).length / xs.length;
    return `n ${String(xs.length).padStart(4)} · mean ${pct(g, 2).padStart(7)} (t ${((g / sd) * Math.sqrt(xs.length)).toFixed(1).padStart(5)}) · median ${pct(med, 2).padStart(7)} · net 0.2% ${pct(g - 0.002, 2).padStart(7)} · win ${(100 * win).toFixed(0)}%`;
  };
  for (const [key, xs] of book) {
    console.log(`  ${key.padEnd(30)} ${line(xs.filter((r) => r.at < SPLIT))}`);
    console.log(`  ${"".padEnd(30)} ${line(xs.filter((r) => r.at >= SPLIT))}`);
  }
  console.log("\nPER YEAR, mean gross (n)");
  for (const [key, xs] of book) {
    const years: string[] = [];
    for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
      const ys = xs.filter((r) => new Date(r.at).getUTCFullYear() === y);
      years.push(ys.length ? `${y} ${pct(ys.reduce((s, r) => s + r.gross, 0) / ys.length, 1)} (${ys.length})` : `${y} –`);
    }
    console.log(`  ${key.padEnd(30)} ${years.join(" · ")}`);
  }
  const best = (book.get("D1 breakout") ?? []).concat(book.get("ORB-4h") ?? []).sort((p, q) => q.gross - p.gross);
  console.log(`\nLargest ORB/D1 trades: ${best.slice(0, 5).map((r) => `${r.symbol} ${pct(r.gross, 0)}`).join(" · ")}`);
}

if (process.argv[1]?.endsWith("listing.ts")) void main();
