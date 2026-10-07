/**
 * The owner's refinements of the value-area trades (auction.ts / auction-htf.ts / footprint.ts),
 * both directions, on four timeframes: 4h profile → 1h entries, 1h → 15m, and the previous
 * day's profile on 5m and 1m bars built from aggTrades. Rules fixed before looking at results.
 *
 * Signal as before: a close beyond VAH/VAL (the previous close not beyond) → the first bar back
 * within `tol` of the edge is the retest; it closes beyond → continuation in the breakout's
 * direction, it closes back inside → reversion against it. Then, stacked one change at a time:
 *
 *   A  TP 2R            entry at the retest's close, the original stop (past the retest's or
 *                       the excursion's extreme), target 2R for every scenario (the POC before)
 *   B  + SL at node     the stop goes past the heaviest volume node on the protective side:
 *                       a 30-row profile of the 48 bars up to the entry; for a long the
 *                       highest-volume row wholly below the entry (within the stop limits),
 *                       stop `buf` under its low (a short: above, past its high). No such row →
 *                       no trade. Historical order books are not archived; the heaviest traded
 *                       price is where size actually changed hands.
 *   C  + 3 delta        no entry at the retest: wait for three bars in a row whose taker flow
 *                       leans the trade's way (buy ratio > 0.5 for a long, < 0.5 for a short),
 *                       starting after the retest and done within 6 bars, with the close still on
 *                       the trade's side of the edge (continuation: beyond it; reversion: back
 *                       inside) → enter at the third bar's close; stop at the node, target 2R.
 *
 * Out after `hold` bars; a stop and a target in the same bar count as the stop; one position
 * per pair and rule at a time. Gross = the break-even cost; net at 0.2% (spot), 0.04% (futures
 * maker), 0.1% (futures taker). Per event = trades entered in the same bar count as one.
 *
 *   npx tsx research/auction-refine.ts
 */
import fs from "node:fs";
import path from "node:path";
import { buildProfile } from "../lib/profile";
import type { Candle } from "../lib/types";
import { FOOTPRINT_MONTHS, FOOTPRINT_PAIRS, footprintFile, type Footprint } from "./aggtrades";
import { COMBOS, levelsByDay, load, type Levels } from "./auction-htf";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { SCALES, toBars } from "./footprint";
import { INTRADAY_PAIRS } from "./intraday-pairs";
import { prefix, stats, type Sample } from "./intraday-edge";
import { pct } from "./momentum";
import { inUniverse } from "./universe";
import { dailyLevels } from "./value-area";

type Dir = 1 | -1;
export const TRADES_FILE = path.join(CACHE_DIR, "auction-refine-trades.json");
interface Params {
  name: string;
  window: number;
  tol: number;
  buf: number;
  minStop: number;
  maxStop: number;
  hold: number;
  barSec: number;
  split: number;
}
interface Trade extends Sample {
  reason: "stop" | "target" | "time";
  symbol: string;
  /** Distance to the stop as a share of the entry (1R). */
  risk: number;
  exitAt: number; // ms
}

const book = new Map<string, Trade[]>();
const splits = new Map<string, number>();
const skipped = new Map<string, number>();
const skip = (k: string) => skipped.set(k, (skipped.get(k) ?? 0) + 1);

function hold(c: ResearchBar[], e: number, d: Dir, stop: number, target: number, maxBars: number, barSec: number): Pick<Trade, "gross" | "reason"> & { bar: number } {
  const entry = c[e].close;
  const end = Math.min(c.length - 1, e + maxBars);
  for (let x = e + 1; x <= end; x++) {
    const b = c[x];
    if (b.time - c[x - 1].time > 4 * barSec) return { gross: (d * (c[x - 1].close - entry)) / entry, bar: x - 1, reason: "time" };
    if (d === 1 ? b.low <= stop : b.high >= stop) return { gross: (d * ((d === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - entry)) / entry, bar: x, reason: "stop" };
    if (d === 1 ? b.high >= target : b.low <= target) return { gross: (d * ((d === 1 ? Math.max(b.open, target) : Math.min(b.open, target)) - entry)) / entry, bar: x, reason: "target" };
  }
  return { gross: (d * (c[end].close - entry)) / entry, bar: end, reason: "time" };
}

/** Stop past the heaviest volume row on the protective side of the 48 bars up to e; null when none fits. */
function nodeStop(c: ResearchBar[], e: number, d: Dir, p: Params): number | null {
  const prof = buildProfile(c as unknown as Candle[], Math.max(0, e - 47), e, { rows: 30, valueAreaPct: 70, lvnRatio: 0.35 });
  if (!prof) return null;
  const entry = c[e].close;
  let best = -1;
  let bestVol = 0;
  prof.rows.forEach((r, k) => {
    const top = r.low + prof.rowSize;
    const stop = d === 1 ? r.low * (1 - p.buf) : top * (1 + p.buf);
    const onSide = d === 1 ? top < entry : r.low > entry;
    const dist = Math.abs(entry - stop) / entry;
    const vol = r.buy + r.sell;
    if (onSide && dist >= p.minStop && dist <= p.maxStop && vol > bestVol) {
      best = k;
      bestVol = vol;
    }
  });
  if (best < 0) return null;
  const r = prof.rows[best];
  return d === 1 ? r.low * (1 - p.buf) : (r.low + prof.rowSize) * (1 + p.buf);
}

function scan(p: Params, symbol: string, c: ResearchBar[], levelAt: (i: number) => Levels | null, liquid: (i: number) => boolean) {
  const n = c.length;
  const busy = new Map<string, number>();
  const take = (key: string, e: number, d: Dir, stop: number) => {
    if ((busy.get(key) ?? -1) >= e) return;
    const entry = c[e].close;
    const { bar, ...r } = hold(c, e, d, stop, entry + d * 2 * Math.abs(entry - stop), p.hold, p.barSec);
    busy.set(key, bar);
    const list = book.get(key) ?? [];
    list.push({ at: (c[e].time + p.barSec) * 1000, ...r, symbol, risk: Math.abs(entry - stop) / entry, exitAt: (c[bar].time + p.barSec) * 1000 });
    book.set(key, list);
    splits.set(key, p.split);
  };
  const leans = (k: number, d: Dir) => {
    const ratio = c[k].volume > 0 ? (c[k].buyVolume ?? 0) / c[k].volume : 0.5;
    return d === 1 ? ratio > 0.5 : ratio < 0.5;
  };
  for (let i = 1; i < n - 2; i++) {
    const L = levelAt(i);
    if (!L || !liquid(i)) continue;
    for (const [edge, d] of [[L.vah, 1], [L.val, -1]] as const) {
      const beyond = (px: number) => (d === 1 ? px > edge : px < edge);
      if (!beyond(c[i].close) || beyond(c[i - 1].close)) continue;
      for (let j = i + 1; j <= Math.min(n - 2, i + p.window); j++) {
        const back = d === 1 ? c[j].low <= edge * (1 + p.tol) : c[j].high >= edge * (1 - p.tol);
        if (!back) continue;
        const holds = beyond(c[j].close);
        const t: Dir = holds ? d : (-d as Dir);
        const name = `${p.name} · ${d === 1 ? "VAH" : "VAL"} ${holds ? "continuation" : "fails"} (${t === 1 ? "long" : "short"})`;

        // A: the original stop, target 2R
        let stopA: number;
        if (holds) stopA = d === 1 ? Math.min(c[j].low, edge) * (1 - p.buf) : Math.max(c[j].high, edge) * (1 + p.buf);
        else {
          let ext = d === 1 ? -Infinity : Infinity;
          for (let q = i; q <= j; q++) ext = d === 1 ? Math.max(ext, c[q].high) : Math.min(ext, c[q].low);
          stopA = d === 1 ? ext * (1 + p.buf) : ext * (1 - p.buf);
        }
        const sdA = Math.abs(c[j].close - stopA) / c[j].close;
        if (sdA >= p.minStop && sdA <= p.maxStop) take(`${name} · A TP 2R`, j, t, stopA);

        // B: stop at the volume node
        const stopB = nodeStop(c, j, t, p);
        if (stopB === null) skip(`${name} · B`);
        else take(`${name} · B + SL at node`, j, t, stopB);

        // C: three bars of taker flow the trade's way, then the node stop
        let run = 0;
        for (let e = j + 1; e <= Math.min(n - 2, j + 6); e++) {
          run = leans(e, t) ? run + 1 : 0;
          if (run < 3) continue;
          const onSide = holds ? beyond(c[e].close) : !beyond(c[e].close);
          if (!onSide) break;
          const stopC = nodeStop(c, e, t, p);
          if (stopC === null) skip(`${name} · C`);
          else take(`${name} · C + 3 delta`, e, t, stopC);
          break;
        }
        break;
      }
    }
  }
}

async function main() {
  const DAY = 86_400;
  // 4h → 1h and 1h → 15m from klines
  for (const k of [COMBOS[1], COMBOS[0]]) {
    const p: Params = { name: k.name, window: k.window, tol: k.tol, buf: k.buf, minStop: k.minStop, maxStop: k.maxStop, hold: k.hold, barSec: k.ltfSec, split: Date.UTC(2024, 6, 1) };
    const symbols = k.ltf === "15m" ? INTRADAY_PAIRS : (await archiveSymbols()).filter(inUniverse);
    for (const symbol of symbols) {
      const htf = load(k.htf, symbol);
      const ltf = load(k.ltf, symbol);
      if (!htf || !ltf || htf.length < 200) continue;
      const levels = levelsByDay(htf, k);
      for (const c of segments(ltf, 6 * k.ltfSec * 1000)) {
        if (c.length < 500) continue;
        const qv = prefix(c.map((b) => b.quoteVolume));
        const perDay = DAY / k.ltfSec;
        const liquid = k.ltf === "15m" ? () => true : (i: number) => i >= 30 * perDay && (qv[i] - qv[i - 30 * perDay]) / 30 >= 5e6;
        scan(p, symbol, c, (i) => levels.get(Math.floor(c[i].time / DAY)) ?? null, liquid);
      }
    }
    console.log(`${k.name} done`);
  }
  // 5m and 1m from aggTrades
  for (const S of SCALES) {
    const p: Params = { name: `${S.name === "1m" ? "1m" : "5m"} (aggTrades)`, window: S.window, tol: S.tol, buf: S.buf, minStop: S.minStop, maxStop: S.maxStop, hold: S.hold, barSec: S.barMs / 1000, split: Date.UTC(2025, 0, 1) };
    for (const symbol of FOOTPRINT_PAIRS) {
      const raw: Footprint[] = FOOTPRINT_MONTHS.map((m) => footprintFile(symbol, m)).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
      const bars = raw.flatMap((f) => toBars(f, S.barMs / 1000));
      for (const c of segments(bars, 30 * 60_000)) {
        if (c.length < S.profileBars * 2) continue;
        const lv = dailyLevels(c, S);
        scan(p, symbol, c, (i) => lv[i], () => true);
      }
    }
    console.log(`${p.name} done`);
  }

  console.log("\nIS │ OOS: klines 2021 → 2024-06 │ after; aggTrades 2024-01 → 06 │ 2026-03 → 08");
  console.log("PER TRADE: n · gross (t per event) · net spot 0.2% · maker 0.04% · taker 0.1% · stop/target/time");
  const row = (xs: Trade[]) => {
    const s = stats(xs);
    if (!s) return "–";
    const share = (r: Trade["reason"]) => `${((100 * xs.filter((t) => t.reason === r).length) / xs.length).toFixed(0)}%`;
    return `n ${String(s.n).padStart(6)} · ${pct(s.g, 3).padStart(8)} (t ${s.eventT.toFixed(1).padStart(5)}) · ${pct(s.g - 0.002, 2).padStart(7)} · ${pct(s.g - 0.0004, 3).padStart(8)} · ${pct(s.g - 0.001, 3).padStart(8)} · ${share("stop")}/${share("target")}/${share("time")}`;
  };
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    const split = splits.get(key) ?? 0;
    console.log(`  ${key}`);
    console.log(`    IS  ${row(xs.filter((t) => t.at < split))}`);
    console.log(`    OOS ${row(xs.filter((t) => t.at >= split))}`);
  }
  // the trades of every rule, for research/auction-short.ts
  fs.writeFileSync(TRADES_FILE, JSON.stringify(Object.fromEntries(book)));
  console.log(`\nSkipped for want of a volume node within the stop limits: ${[...skipped].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
}

if (process.argv[1]?.endsWith("auction-refine.ts")) void main();
