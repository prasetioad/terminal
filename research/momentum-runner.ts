/**
 * Gemini's Hypothesis A (Discussion.md): "Relative Strength Leader & Volatility Expansion".
 * Trade only coins already in a real expansion, so a move of several % in hours dwarfs the
 * 0.2% cost; enter on the pullback after the first impulse. 1h candles, the whole
 * survivorship-free universe, long only. Rules fixed before looking at results:
 *
 *   trigger   24h return ≥ +10% and 24h quote volume ≥ 3× the daily average of the 30 days
 *             before; that average ≥ $2M (a coin people could already trade). One trigger per
 *             pair per 24h.
 *   entry     chase: the trigger bar's close
 *             VWAP pullback: within 12 bars, the first bar whose low touches the rolling 24h
 *               VWAP and closes above it (a close below it first cancels the trigger)
 *             EMA20 pullback: the same with the 1h EMA20
 *   exit      12h: the close 12 bars after entry (the gross edge, no stop)
 *             bracket (Gemini's Hypothesis C): stop 2 × ATR14 under the entry, moved to the
 *               entry once +1R is touched, target 3R, out at the close after 12h; a stop and
 *               a target in the same bar count as the stop
 *
 * Trades are also judged per event (per entry hour), since a hot sector moves together.
 * In-sample 2021 → 2024-06, out-of-sample after.
 *
 *   npx tsx research/momentum-runner.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { atr14, cell, prefix, stats, type Sample } from "./intraday-edge";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const H1 = 3_600_000;
const SPLIT = Date.UTC(2024, 6, 1);
const ENTRIES = ["chase", "VWAP pullback", "EMA20 pullback"] as const;
const EXITS = ["12h", "bracket 3R"] as const;

function ema(c: ResearchBar[], n: number): Float64Array {
  const out = new Float64Array(c.length);
  const k = 2 / (n + 1);
  out[0] = c[0].close;
  for (let i = 1; i < c.length; i++) out[i] = c[i].close * k + out[i - 1] * (1 - k);
  return out;
}

function exitOf(c: ResearchBar[], j: number, a: number, exit: (typeof EXITS)[number]): number {
  const entry = c[j].close;
  const last = Math.min(c.length - 1, j + 12);
  if (exit === "12h") return c[last].close / entry - 1;
  const r = 2 * a;
  let stop = entry - r;
  const target = entry + 3 * r;
  for (let x = j + 1; x <= last; x++) {
    if (c[x].low <= stop) return Math.min(c[x].open, stop) / entry - 1;
    if (c[x].high >= target) return Math.max(c[x].open, target) / entry - 1;
    if (c[x].high >= entry + r) stop = Math.max(stop, entry);
  }
  return c[last].close / entry - 1;
}

function runners(c: ResearchBar[], book: Map<string, Sample[]>) {
  const n = c.length;
  const a = atr14(c);
  const e20 = ema(c, 20);
  const qv = prefix(c.map((b) => b.quoteVolume));
  const bv = prefix(c.map((b) => b.volume));
  const vwap = (j: number) => (qv[j + 1] - qv[j - 23]) / (bv[j + 1] - bv[j - 23]);
  let lastTrigger = -Infinity;
  for (let i = 744; i < n - 13; i++) {
    if (i - lastTrigger < 24) continue;
    if (!(c[i].close / c[i - 24].close - 1 >= 0.1)) continue;
    const avgDaily = (qv[i - 23] - qv[i - 23 - 720]) / 30;
    if (avgDaily < 2e6 || qv[i + 1] - qv[i - 23] < 3 * avgDaily) continue;
    lastTrigger = i;
    const at = (j: number) => c[j].time * 1000 + H1;
    const take = (entry: (typeof ENTRIES)[number], j: number) => {
      for (const ex of EXITS) {
        const key = `${entry} · ${ex}`;
        const list = book.get(key) ?? [];
        list.push({ at: at(j), gross: exitOf(c, j, a[j], ex) });
        book.set(key, list);
      }
    };
    take("chase", i);
    for (const [entry, level] of [
      ["VWAP pullback", vwap],
      ["EMA20 pullback", (j: number) => e20[j]],
    ] as const) {
      for (let j = i + 1; j <= Math.min(n - 13, i + 12); j++) {
        const lv = level(j);
        if (c[j].close < lv) break;
        if (c[j].low <= lv) {
          take(entry, j);
          break;
        }
      }
    }
  }
}

async function main() {
  const book = new Map<string, Sample[]>();
  const symbols = (await archiveSymbols()).filter(inUniverse);
  let pairs = 0;
  for (const symbol of symbols) {
    const file = path.join(CACHE_DIR, "klines", "1h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    pairs++;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const c of segments(all, 6 * H1)) if (c.length >= 800) runners(c, book);
  }
  console.log(`${pairs} pairs (1h) · trigger 24h ≥ +10% on ≥ 3× volume · IS 2021 → 2024-06 │ OOS 2024-07 → now\n`);
  console.log("PER TRADE (IS on the first line, OOS on the second)");
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    console.log(`  ${key.padEnd(28)} ${cell(xs.filter((t) => t.at < SPLIT))}`);
    console.log(`  ${"".padEnd(28)} ${cell(xs.filter((t) => t.at >= SPLIT))}`);
  }
  console.log("\nPER YEAR, gross per trade (n)");
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    const years: string[] = [];
    for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
      const s = stats(xs.filter((t) => new Date(t.at).getUTCFullYear() === y));
      years.push(s ? `${y} ${pct(s.g, 2)} (${s.n})` : `${y} –`);
    }
    console.log(`  ${key.padEnd(28)} ${years.join(" · ")}`);
  }
}

if (process.argv[1]?.endsWith("momentum-runner.ts")) void main();
