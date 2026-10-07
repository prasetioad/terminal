/**
 * Gemini's "how professionals trade the support bounce" (Discussion.md, VIRTUAL 1h): wait for
 * the support to be swept, buy the reclaim, stop under the sweep's wick, target the range
 * high — only in a ranging market or above the daily EMA200. 1h candles, the whole
 * survivorship-free universe (≥ $5M/day), long only. Rules fixed before looking at results:
 *
 *   support / resistance  the lowest low / highest high of the 48 bars (2 days) before
 *   sweep & reclaim       a bar's low goes under the support; within 2 bars (the sweep bar
 *                         included) a close is back above it → buy that close
 *   stop                  0.2% under the lowest low since the sweep (skip if > 8% away)
 *   target                the resistance (skip if it is < 1R away); out after 48 bars
 *   regime                none · ranging (ADX14 1h < 25) · uptrend (above the EMA200 of daily
 *                         closes up to the day before)
 *
 * Gross mean = break-even cost; net shown at 0.2% (spot, market orders) and 0.04% (futures,
 * maker orders — the cost Gemini's version assumes). Judged per trade and per event (all
 * trades entered in the same hour count as one). In-sample 2021 → 2024-06, out-of-sample after.
 *
 *   npx tsx research/support-reclaim.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { cell, prefix, stats, type Sample } from "./intraday-edge";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const H1 = 3_600_000;
const SPLIT = Date.UTC(2024, 6, 1);
const L = 48;
const REGIMES = ["no filter", "ranging (ADX < 25)", "uptrend (> EMA200 1D)"] as const;

/** Wilder ADX14. */
function adx14(c: ResearchBar[]): Float64Array {
  const n = c.length;
  const out = new Float64Array(n).fill(Number.NaN);
  let tr = 0;
  let pdm = 0;
  let mdm = 0;
  let adx = 0;
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    const t = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    const p = up > down && up > 0 ? up : 0;
    const m = down > up && down > 0 ? down : 0;
    if (i <= 14) {
      tr += t;
      pdm += p;
      mdm += m;
    } else {
      tr = tr - tr / 14 + t;
      pdm = pdm - pdm / 14 + p;
      mdm = mdm - mdm / 14 + m;
    }
    if (i < 14 || tr === 0) continue;
    const pdi = pdm / tr;
    const mdi = mdm / tr;
    const dx = pdi + mdi > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    adx = i < 28 ? adx + dx / 14 : (adx * 13 + dx) / 14;
    if (i >= 28) out[i] = 100 * adx;
  }
  return out;
}

/** For each bar, the EMA200 of daily closes (the last 1h close of each UTC day) up to the day before. */
function dailyEma200(c: ResearchBar[]): Float64Array {
  const out = new Float64Array(c.length).fill(Number.NaN);
  const k = 2 / 201;
  let ema = Number.NaN;
  let days = 0;
  let today = Math.floor(c[0].time / 86_400);
  let prevEma = Number.NaN;
  for (let i = 0; i < c.length; i++) {
    const day = Math.floor(c[i].time / 86_400);
    if (day !== today) {
      // c[i - 1] closed the previous day
      days++;
      ema = Number.isNaN(ema) ? c[i - 1].close : c[i - 1].close * k + ema * (1 - k);
      prevEma = days >= 200 ? ema : Number.NaN;
      today = day;
    }
    out[i] = prevEma;
  }
  return out;
}

function trades(c: ResearchBar[], book: Map<string, Sample[]>) {
  const n = c.length;
  const adx = adx14(c);
  const ema = dailyEma200(c);
  const qv = prefix(c.map((b) => b.quoteVolume));
  const busy = new Map<string, number>();
  for (let i = Math.max(L, 720); i < n - 2; i++) {
    let sup = Number.POSITIVE_INFINITY;
    let res = Number.NEGATIVE_INFINITY;
    for (let k = i - L; k < i; k++) {
      sup = Math.min(sup, c[k].low);
      res = Math.max(res, c[k].high);
    }
    if (!(c[i].low < sup)) continue;
    let j = -1;
    for (let k = i; k <= Math.min(n - 2, i + 2); k++) {
      if (c[k].close > sup) {
        j = k;
        break;
      }
    }
    if (j < 0) continue;
    if (((qv[j] - qv[j - 720]) / 720) * 24 < 5e6) continue;
    let low = Number.POSITIVE_INFINITY;
    for (let k = i; k <= j; k++) low = Math.min(low, c[k].low);
    const entry = c[j].close;
    const stop = low * 0.998;
    const risk = entry - stop;
    if (risk / entry > 0.08 || res - entry < risk) continue;
    const ok: Record<(typeof REGIMES)[number], boolean> = {
      "no filter": true,
      "ranging (ADX < 25)": adx[j] < 25,
      "uptrend (> EMA200 1D)": entry > ema[j],
    };
    // hold: stop first, then target, out after 48 bars
    let gross = Number.NaN;
    let exitBar = Math.min(n - 1, j + 48);
    for (let x = j + 1; x <= exitBar; x++) {
      if (c[x].low <= stop) {
        gross = Math.min(c[x].open, stop) / entry - 1;
        exitBar = x;
        break;
      }
      if (c[x].high >= res) {
        gross = Math.max(c[x].open, res) / entry - 1;
        exitBar = x;
        break;
      }
    }
    if (Number.isNaN(gross)) gross = c[exitBar].close / entry - 1;
    for (const r of REGIMES) {
      if (!ok[r] || (busy.get(r) ?? -1) >= j) continue;
      busy.set(r, exitBar);
      const list = book.get(r) ?? [];
      list.push({ at: c[j].time * 1000 + H1, gross });
      book.set(r, list);
    }
    i = j;
  }
}

async function main() {
  const book = new Map<string, Sample[]>();
  let pairs = 0;
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", "1h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    pairs++;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const c of segments(all, 6 * H1)) if (c.length >= 1000) trades(c, book);
  }
  console.log(`${pairs} pairs (1h, ≥ $5M/day) · sweep & reclaim of the 48-bar low, target the 48-bar high · IS → 2024-06 │ OOS after\n`);
  for (const r of REGIMES) {
    const xs = book.get(r) ?? [];
    const is = xs.filter((t) => t.at < SPLIT);
    const oos = xs.filter((t) => t.at >= SPLIT);
    console.log(`  ${r.padEnd(24)} ${cell(is)}`);
    console.log(`  ${"".padEnd(24)} ${cell(oos)}`);
    const f = (s: ReturnType<typeof stats>) => (s ? `net 0.04% ${pct(s.g - 0.0004, 2)}` : "–");
    console.log(`  ${"".padEnd(24)} futures maker: IS ${f(stats(is))} │ OOS ${f(stats(oos))}`);
  }
  console.log("\nPER YEAR, gross per trade (n)");
  for (const r of REGIMES) {
    const xs = book.get(r) ?? [];
    const years: string[] = [];
    for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
      const s = stats(xs.filter((t) => new Date(t.at).getUTCFullYear() === y));
      years.push(s ? `${y} ${pct(s.g, 2)} (${s.n})` : `${y} –`);
    }
    console.log(`  ${r.padEnd(24)} ${years.join(" · ")}`);
  }
  const v = (book.get("no filter") ?? []).length;
  console.log(`\n(${v} trades without a filter; one position per pair at a time per regime)`);
}

if (process.argv[1]?.endsWith("support-reclaim.ts")) void main();
