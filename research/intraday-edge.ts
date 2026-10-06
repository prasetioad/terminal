/**
 * Intraday round 1 of the Claude × Gemini discussion (Discussion.md): three ideas that differ
 * in kind from the price-pattern entries that already failed (§4.19–4.26), on 1h candles of
 * the whole survivorship-free universe (pairs ≥ $5M/day, point in time), long only.
 * Rules fixed before looking at results.
 *
 *   SEASONALITY   mean return of each UTC hour, across pairs (equal weight) and for BTC.
 *                 A diagnostic: a window only matters if it beats one round-trip cost.
 *   FLUSH         a capitulation bar: close ≤ previous close − k × ATR14 (k = 3, 4) on
 *                 volume ≥ 3× its 48-bar average → buy that close. Context: any · the pair
 *                 above its 50-day average (uptrend) · BTC calm in that hour (the flush is the
 *                 pair's own) · BTC flushing too (market-wide). Exit: after 3h / 12h / 24h, or
 *                 a bracket — target the flush bar's open, stop 1.5 × ATR under the entry,
 *                 out after 24h. One position per pair at a time.
 *   DAY MOMENTUM  a day already up ≥ x × its daily range (14-day average of high − low) by
 *                 12:00 UTC (x = 0.5, 1), optionally on ≥ 1.5× its usual volume by then →
 *                 buy the 12:00 close, sell the day's close (24:00). Intraday time-series
 *                 momentum as reported for equities (the first part of the day predicts the last).
 *
 * The gross mean per trade is the break-even cost; a spot account pays ≈ 0.2% per round
 * trip (market orders), 0.15% with BNB fees. A stop and a target in the same bar count as
 * the stop. In-sample 2021 → 2024-06, out-of-sample after.
 *
 *   npx tsx research/intraday-edge.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const H1 = 3_600_000;
const SPLIT = Date.UTC(2024, 6, 1);
const MIN_LIQUIDITY = 5e6;

export interface Sample {
  at: number; // ms, entry time
  gross: number;
}
type Book = Map<string, Sample[]>;
const add = (book: Book, key: string, s: Sample) => {
  const list = book.get(key);
  if (list) list.push(s);
  else book.set(key, [s]);
};

/** Wilder ATR14. */
export function atr14(c: ResearchBar[]): Float64Array {
  const out = new Float64Array(c.length).fill(Number.NaN);
  let a = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    a = i <= 14 ? a + tr / 14 : (a * 13 + tr) / 14;
    if (i >= 14) out[i] = a;
  }
  return out;
}

export const prefix = (xs: number[]) => {
  const p = [0];
  for (const x of xs) p.push(p[p.length - 1] + x);
  return p;
};

/** BTC's own flush z-score per hour (drop in ATRs), to tell idiosyncratic flushes from market-wide ones. */
function btcShock(): Map<number, number> {
  const c: ResearchBar[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "klines", "1h", "BTCUSDT.json"), "utf8"));
  const a = atr14(c);
  const out = new Map<number, number>();
  for (let i = 15; i < c.length; i++) out.set(c[i].time, (c[i - 1].close - c[i].close) / a[i - 1]);
  return out;
}

const FLUSH_K = [3, 4] as const;
const CONTEXTS = ["any", "uptrend", "BTC calm", "BTC flushing"] as const;
const EXITS = ["3h", "12h", "24h", "bracket"] as const;

function flush(c: ResearchBar[], btc: Map<number, number>, book: Book) {
  const n = c.length;
  const a = atr14(c);
  const qv = prefix(c.map((b) => b.quoteVolume));
  const cl = prefix(c.map((b) => b.close));
  const liq = (i: number) => (qv[i + 1] - qv[Math.max(0, i + 1 - 720)]) / Math.min(i + 1, 720) * 24;
  // one position per pair and variant: the bar each variant is busy until
  const busy = new Map<string, number>();
  for (let i = 1200; i < n - 1; i++) {
    const drop = (c[i - 1].close - c[i].close) / a[i - 1];
    if (!(drop >= FLUSH_K[0])) continue;
    const avgVol = (qv[i] - qv[i - 48]) / 48;
    if (!(c[i].quoteVolume >= 3 * avgVol) || liq(i) < MIN_LIQUIDITY) continue;
    const sma50d = (cl[i] - cl[i - 1200]) / 1200; // before this bar
    const b = btc.get(c[i].time);
    const ctx: Record<(typeof CONTEXTS)[number], boolean> = {
      any: true,
      uptrend: c[i - 1].close > sma50d,
      "BTC calm": b !== undefined && b < 1,
      "BTC flushing": b !== undefined && b >= 2,
    };
    const entry = c[i].close;
    const at = c[i].time * 1000 + H1;
    for (const k of FLUSH_K) {
      if (drop < k) continue;
      for (const cx of CONTEXTS) {
        if (!ctx[cx]) continue;
        for (const ex of EXITS) {
          const key = `flush ${k}×ATR · ${cx} · ${ex}`;
          if ((busy.get(key) ?? -1) >= i) continue;
          let exitBar: number;
          let exitPx: number;
          if (ex !== "bracket") {
            exitBar = Math.min(n - 1, i + Number.parseInt(ex));
            exitPx = c[exitBar].close;
          } else {
            const target = c[i].open;
            const stop = entry - 1.5 * a[i];
            exitBar = Math.min(n - 1, i + 24);
            exitPx = c[exitBar].close;
            for (let x = i + 1; x <= Math.min(n - 1, i + 24); x++) {
              if (c[x].low <= stop) {
                exitBar = x;
                exitPx = Math.min(c[x].open, stop);
                break;
              }
              if (c[x].high >= target) {
                exitBar = x;
                exitPx = Math.max(c[x].open, target);
                break;
              }
            }
          }
          busy.set(key, exitBar);
          add(book, key, { at, gross: exitPx / entry - 1 });
        }
      }
    }
  }
}

function dayMomentum(c: ResearchBar[], book: Book) {
  // whole UTC days only: index of each day's 00:00 bar with 24 consecutive hours
  const days: number[] = [];
  for (let i = 0; i + 23 < c.length; i++) {
    if (c[i].time % 86_400 === 0 && c[i + 23].time - c[i].time === 23 * 3600) days.push(i);
  }
  const range: number[] = [];
  const vol12: number[] = [];
  for (const s of days) {
    let hi = -Infinity;
    let lo = Infinity;
    let v = 0;
    for (let k = s; k < s + 24; k++) {
      hi = Math.max(hi, c[k].high);
      lo = Math.min(lo, c[k].low);
      if (k < s + 12) v += c[k].quoteVolume;
    }
    range.push((hi - lo) / c[s].open);
    vol12.push(v);
  }
  for (let d = 30; d < days.length; d++) {
    const s = days[d];
    // the last 14 days must be consecutive
    if (c[s].time - c[days[d - 14]].time !== 14 * 86_400) continue;
    const avgRange = range.slice(d - 14, d).reduce((x, y) => x + y, 0) / 14;
    const avgVol = vol12.slice(d - 14, d).reduce((x, y) => x + y, 0) / 14;
    let liq = 0;
    for (let k = d - 30; k < d; k++) liq += vol12[k];
    if ((liq / 30) * 2 < MIN_LIQUIDITY) continue; // ≈ daily volume from the first halves
    const up = c[s + 11].close / c[s].open - 1;
    const entry = c[s + 11].close;
    const gross = c[s + 23].close / entry - 1;
    const at = c[s].time * 1000 + 12 * H1;
    for (const x of [0.5, 1]) {
      if (up < x * avgRange) continue;
      add(book, `day momentum ≥ ${x}× range by 12:00`, { at, gross });
      if (vol12[d] >= 1.5 * avgVol) add(book, `day momentum ≥ ${x}× range by 12:00 + volume 1.5×`, { at, gross });
    }
    add(book, "every day, 12:00 → 24:00 (baseline)", { at, gross });
  }
}

function seasonality(c: ResearchBar[], hours: { is: number[][]; oos: number[][] }) {
  const qv = prefix(c.map((b) => b.quoteVolume));
  for (let i = 720; i < c.length; i++) {
    if (c[i].time - c[i - 1].time !== 3600) continue;
    if (((qv[i] - qv[i - 720]) / 720) * 24 < MIN_LIQUIDITY) continue;
    const h = new Date(c[i].time * 1000).getUTCHours();
    (c[i].time * 1000 < SPLIT ? hours.is : hours.oos)[h].push(c[i].close / c[i - 1].close - 1);
  }
}

export function stats(xs: Sample[]) {
  if (!xs.length) return null;
  const g = xs.reduce((s, t) => s + t.gross, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, t) => s + (t.gross - g) ** 2, 0) / Math.max(1, xs.length - 1));
  const win = xs.filter((t) => t.gross - 0.002 > 0).length / xs.length;
  // Trades in the same hour are one event (a market-wide flush hits dozens of pairs at once):
  // the t-stat across events, each the mean of its trades, is the honest one.
  const byHour = new Map<number, number[]>();
  for (const t of xs) byHour.set(t.at, [...(byHour.get(t.at) ?? []), t.gross]);
  const ev = [...byHour.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const eg = ev.reduce((a, b) => a + b, 0) / ev.length;
  const esd = Math.sqrt(ev.reduce((a, b) => a + (b - eg) ** 2, 0) / Math.max(1, ev.length - 1));
  return { n: xs.length, g, t: (g / sd) * Math.sqrt(xs.length), win, events: ev.length, eventT: (eg / esd) * Math.sqrt(ev.length) };
}
export const cell = (xs: Sample[]) => {
  const s = stats(xs);
  if (!s) return "–".padEnd(52);
  return `n ${String(s.n).padStart(6)} · gross ${pct(s.g, 3).padStart(8)} (t ${s.t.toFixed(1).padStart(5)}) · net 0.2% ${pct(s.g - 0.002, 2).padStart(7)} · win ${(100 * s.win).toFixed(0)}% · ${s.events} events (t ${s.eventT.toFixed(1)})`;
};

async function main() {
  const btc = btcShock();
  const book: Book = new Map();
  const hours = { is: Array.from({ length: 24 }, () => [] as number[]), oos: Array.from({ length: 24 }, () => [] as number[]) };
  const btcHours = { is: Array.from({ length: 24 }, () => [] as number[]), oos: Array.from({ length: 24 }, () => [] as number[]) };
  const symbols = (await archiveSymbols()).filter(inUniverse);
  let pairs = 0;
  for (const symbol of symbols) {
    const file = path.join(CACHE_DIR, "klines", "1h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    pairs++;
    for (const c of segments(all, 6 * H1)) {
      if (c.length < 1500) continue;
      flush(c, btc, book);
      dayMomentum(c, book);
      seasonality(c, symbol === "BTCUSDT" ? btcHours : hours);
    }
  }
  console.log(`${pairs} pairs (1h, ≥ $5M/day point in time) · IS 2021 → 2024-06 │ OOS 2024-07 → now\n`);

  console.log("SEASONALITY: mean return per UTC hour, all pairs │ BTC (IS / OOS)");
  const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  for (let h = 0; h < 24; h++) {
    console.log(`  ${String(h).padStart(2)}:00  ${pct(m(hours.is[h]), 3).padStart(8)} / ${pct(m(hours.oos[h]), 3).padStart(8)}   │ ${pct(m(btcHours.is[h]), 3).padStart(8)} / ${pct(m(btcHours.oos[h]), 3).padStart(8)}`);
  }

  const rows = [...book.keys()].sort();
  console.log("\nPER TRADE (IS on the first line, OOS on the second)");
  for (const key of rows) {
    const xs = book.get(key) ?? [];
    console.log(`  ${key.padEnd(46)} ${cell(xs.filter((t) => t.at < SPLIT))}`);
    console.log(`  ${"".padEnd(46)} ${cell(xs.filter((t) => t.at >= SPLIT))}`);
  }

  console.log("\nPER YEAR, gross per trade (n) — rows with IS and OOS net ≥ 0 at 0.2%");
  for (const key of rows) {
    const xs = book.get(key) ?? [];
    const is = stats(xs.filter((t) => t.at < SPLIT));
    const oos = stats(xs.filter((t) => t.at >= SPLIT));
    if (!is || !oos || is.g < 0.002 || oos.g < 0.002) continue;
    const years: string[] = [];
    for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
      const s = stats(xs.filter((t) => new Date(t.at).getUTCFullYear() === y));
      years.push(s ? `${y} ${pct(s.g, 2)} (${s.n})` : `${y} –`);
    }
    console.log(`  ${key}\n    ${years.join(" · ")}`);
  }
}

if (process.argv[1]?.endsWith("intraday-edge.ts")) void main();
