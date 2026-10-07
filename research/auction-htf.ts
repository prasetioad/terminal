/**
 * Auction trades with the value area from a higher timeframe and the entry on a lower one,
 * both directions (owner's request after research/auction.ts and footprint.ts):
 *
 *   1h → 15m   profile of the previous 7 days of 1h bars; breakouts and retests on 15m;
 *              retest within 16 bars (4h), tol 0.1%, buffer 0.2%, stops 0.3–4%, out after 96
 *              bars (24h). The 30 liquid pairs with 15m data (since 2021).
 *   4h → 1h    profile of the previous 30 days of 4h bars; breakouts and retests on 1h;
 *              retest within 24 bars, tol 0.2%, buffer 0.5%, stops 0.5–8%, out after 72 bars
 *              (3 days). The whole universe at ≥ $5M/day.
 *
 * The profile (lib/profile.ts: 60 rows, VA 70%) is rebuilt at each UTC day from the higher
 * timeframe's bars that closed before it. Trades as in auction.ts: a close beyond VAH/VAL
 * (the previous close not beyond) → the first bar back within `tol` is the retest: it closes
 * beyond → continuation (stop past the retest's extreme and the edge, target 2R); it closes
 * back inside → reversion to the POC (stop past the excursion's extreme, POC ≥ 1R away).
 * Variants: base · context (continuation only when the day opened outside value on that side,
 * reversion only when it opened inside) · aggression (the retest bar's taker buy ratio > 0.55
 * for a long, < 0.45 for a short, on volume ≥ 1.5× its 20-bar average) · both.
 *
 * Gross = the break-even cost; net at 0.2% (spot; longs only), 0.04% (futures maker) and 0.1%
 * (futures taker). Per event = trades entered in the same bar count as one.
 * IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/auction-htf.ts
 */
import fs from "node:fs";
import path from "node:path";
import { buildProfile } from "../lib/profile";
import type { Candle } from "../lib/types";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { INTRADAY_PAIRS } from "./intraday-pairs";
import { prefix, stats, type Sample } from "./intraday-edge";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const SPLIT = Date.UTC(2024, 6, 1);
const DAY = 86_400;

export interface Combo {
  name: string;
  htf: string;
  ltf: string;
  htfSec: number;
  ltfSec: number;
  profileDays: number;
  window: number;
  tol: number;
  buf: number;
  minStop: number;
  maxStop: number;
  hold: number;
}

export const COMBOS: Combo[] = [
  { name: "1h → 15m", htf: "1h", ltf: "15m", htfSec: 3600, ltfSec: 900, profileDays: 7, window: 16, tol: 0.001, buf: 0.002, minStop: 0.003, maxStop: 0.04, hold: 96 },
  { name: "4h → 1h", htf: "4h", ltf: "1h", htfSec: 14_400, ltfSec: 3600, profileDays: 30, window: 24, tol: 0.002, buf: 0.005, minStop: 0.005, maxStop: 0.08, hold: 72 },
];

type Dir = 1 | -1;
interface Trade extends Sample {
  reason: "stop" | "target" | "time";
}
export interface Levels {
  vah: number;
  val: number;
  poc: number;
}

export const load = (interval: string, symbol: string): ResearchBar[] | null => {
  const file = path.join(CACHE_DIR, "klines", interval, `${symbol}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};

/** Value area per UTC day from the higher timeframe's bars closed before the day (null: too little history). */
export function levelsByDay(htf: ResearchBar[], k: Combo): Map<number, Levels> {
  const out = new Map<number, Levels>();
  const span = k.profileDays * DAY;
  const need = Math.round((span / k.htfSec) * 0.95);
  let lo = 0;
  let hi = 0;
  const first = Math.floor(htf[0].time / DAY) + k.profileDays;
  const last = Math.floor(htf[htf.length - 1].time / DAY);
  for (let d = first; d <= last; d++) {
    const start = d * DAY;
    while (lo < htf.length && htf[lo].time < start - span) lo++;
    while (hi < htf.length && htf[hi].time + k.htfSec <= start) hi++;
    if (hi - lo < need) continue;
    const p = buildProfile(htf as unknown as Candle[], lo, hi - 1, { rows: 60, valueAreaPct: 70, lvnRatio: 0.35 });
    if (p) out.set(d, { val: p.rows[p.vaLow].low, vah: p.rows[p.vaHigh].low + p.rowSize, poc: p.rows[p.poc].low + p.rowSize / 2 });
  }
  return out;
}

function hold(c: ResearchBar[], e: number, d: Dir, stop: number, target: number, maxBars: number): Omit<Trade, "at"> & { bar: number } {
  const entry = c[e].close;
  const end = Math.min(c.length - 1, e + maxBars);
  for (let x = e + 1; x <= end; x++) {
    const b = c[x];
    if (c[x].time - c[x - 1].time > 4 * (c[1].time - c[0].time)) return { gross: (d * (c[x - 1].close - entry)) / entry, bar: x - 1, reason: "time" };
    if (d === 1 ? b.low <= stop : b.high >= stop) return { gross: (d * ((d === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - entry)) / entry, bar: x, reason: "stop" };
    if (d === 1 ? b.high >= target : b.low <= target) return { gross: (d * ((d === 1 ? Math.max(b.open, target) : Math.min(b.open, target)) - entry)) / entry, bar: x, reason: "target" };
  }
  return { gross: (d * (c[end].close - entry)) / entry, bar: end, reason: "time" };
}

const book = new Map<string, Trade[]>();
const edges = new Map<string, number>();
const tally = (k: string) => edges.set(k, (edges.get(k) ?? 0) + 1);

function scan(k: Combo, c: ResearchBar[], levels: Map<number, Levels>, minLiquidity: number) {
  const n = c.length;
  const vol = prefix(c.map((b) => b.volume));
  const qv = prefix(c.map((b) => b.quoteVolume));
  const perDay = DAY / k.ltfSec;
  const busy = new Map<string, number>();
  const take = (key: string, e: number, d: Dir, stop: number, target: number) => {
    if ((busy.get(key) ?? -1) >= e) return;
    const { bar, ...r } = hold(c, e, d, stop, target, k.hold);
    busy.set(key, bar);
    const list = book.get(key) ?? [];
    list.push({ at: c[e].time * 1000 + k.ltfSec * 1000, ...r });
    book.set(key, list);
  };
  let dayOpen = Number.NaN;
  for (let i = 21; i < n - 2; i++) {
    const day = Math.floor(c[i].time / DAY);
    if (Math.floor(c[i - 1].time / DAY) !== day) dayOpen = c[i].open;
    const L = levels.get(day);
    if (!L || Number.isNaN(dayOpen)) continue;
    if (minLiquidity > 0 && (i < 30 * perDay || (qv[i] - qv[i - 30 * perDay]) / 30 < minLiquidity)) continue;
    const dayState = dayOpen > L.vah ? 1 : dayOpen < L.val ? -1 : 0;

    for (const [edge, d] of [[L.vah, 1], [L.val, -1]] as const) {
      const beyond = (px: number) => (d === 1 ? px > edge : px < edge);
      if (!beyond(c[i].close) || beyond(c[i - 1].close)) continue;
      const side = d === 1 ? "VAH" : "VAL";
      tally(`${k.name} · ${side} breakout`);
      for (let j = i + 1; j <= Math.min(n - 2, i + k.window); j++) {
        const back = d === 1 ? c[j].low <= edge * (1 + k.tol) : c[j].high >= edge * (1 - k.tol);
        if (!back) continue;
        tally(`${k.name} · ${side} retest`);
        const b = c[j];
        const entry = b.close;
        const holds = beyond(entry);
        if (holds) tally(`${k.name} · ${side} holds`);
        const t: Dir = holds ? d : (-d as Dir);
        let stop: number;
        let target: number;
        if (holds) {
          stop = d === 1 ? Math.min(b.low, edge) * (1 - k.buf) : Math.max(b.high, edge) * (1 + k.buf);
          target = entry + t * 2 * Math.abs(entry - stop);
        } else {
          let ext = d === 1 ? -Infinity : Infinity;
          for (let q = i; q <= j; q++) ext = d === 1 ? Math.max(ext, c[q].high) : Math.min(ext, c[q].low);
          stop = d === 1 ? ext * (1 + k.buf) : ext * (1 - k.buf);
          target = L.poc;
          if (t * (target - entry) < Math.abs(entry - stop)) break;
        }
        const sd = Math.abs(entry - stop) / entry;
        if (sd < k.minStop || sd > k.maxStop) break;
        const ratio = b.volume > 0 ? (b.buyVolume ?? 0) / b.volume : 0.5;
        const context = holds ? dayState === d : dayState === 0;
        const aggression = (t === 1 ? ratio > 0.55 : ratio < 0.45) && b.volume >= (1.5 * (vol[j] - vol[j - 20])) / 20;
        const name = `${k.name} · ${side} ${holds ? "continuation" : "fails → POC"} (${t === 1 ? "long" : "short"})`;
        take(`${name} · base`, j, t, stop, target);
        if (context) take(`${name} · context`, j, t, stop, target);
        if (aggression) take(`${name} · aggression`, j, t, stop, target);
        if (context && aggression) take(`${name} · context + aggression`, j, t, stop, target);
        break;
      }
    }
  }
}

async function main() {
  for (const k of COMBOS) {
    const symbols = k.ltf === "15m" ? INTRADAY_PAIRS : (await archiveSymbols()).filter(inUniverse);
    let pairs = 0;
    for (const symbol of symbols) {
      const htf = load(k.htf, symbol);
      const ltf = load(k.ltf, symbol);
      if (!htf || !ltf || htf.length < 200) continue;
      pairs++;
      const levels = levelsByDay(htf, k);
      for (const c of segments(ltf, 6 * k.ltfSec * 1000)) if (c.length >= 500) scan(k, c, levels, k.ltf === "15m" ? 0 : 5e6);
    }
    console.log(`${k.name}: ${pairs} pairs`);
  }
  console.log("IS 2021 → 2024-06 │ OOS after\n");

  console.log("BEHAVIOUR AT THE EDGES (all periods)");
  for (const k of COMBOS) {
    for (const side of ["VAH", "VAL"]) {
      const b = edges.get(`${k.name} · ${side} breakout`) ?? 0;
      const r = edges.get(`${k.name} · ${side} retest`) ?? 0;
      const h = edges.get(`${k.name} · ${side} holds`) ?? 0;
      console.log(`  ${k.name} · ${side}: ${b} closes beyond · retested ${((100 * r) / b).toFixed(0)}% · held ${((100 * h) / r).toFixed(0)}% / failed ${((100 * (r - h)) / r).toFixed(0)}%`);
    }
  }

  console.log("\nPER TRADE: n · gross (t per event) · net spot 0.2% · maker 0.04% · taker 0.1% · stop/target/time");
  const row = (xs: Trade[]) => {
    const s = stats(xs);
    if (!s) return "–";
    const share = (r: Trade["reason"]) => `${((100 * xs.filter((t) => t.reason === r).length) / xs.length).toFixed(0)}%`;
    return `n ${String(s.n).padStart(6)} · ${pct(s.g, 3).padStart(8)} (t ${s.eventT.toFixed(1).padStart(5)}) · ${pct(s.g - 0.002, 2).padStart(7)} · ${pct(s.g - 0.0004, 3).padStart(8)} · ${pct(s.g - 0.001, 3).padStart(8)} · ${share("stop")}/${share("target")}/${share("time")}`;
  };
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    console.log(`  ${key}`);
    console.log(`    IS  ${row(xs.filter((t) => t.at < SPLIT))}`);
    console.log(`    OOS ${row(xs.filter((t) => t.at >= SPLIT))}`);
  }

  console.log("\nPER YEAR, gross per trade (n) — base rows");
  for (const key of [...book.keys()].sort()) {
    if (!key.endsWith("base")) continue;
    const xs = book.get(key) ?? [];
    const years: string[] = [];
    for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
      const s = stats(xs.filter((t) => new Date(t.at).getUTCFullYear() === y));
      years.push(s ? `${y} ${pct(s.g, 2)} (${s.n})` : `${y} –`);
    }
    console.log(`  ${key.padEnd(46)} ${years.join(" · ")}`);
  }
}

if (process.argv[1]?.endsWith("auction-htf.ts")) void main();
