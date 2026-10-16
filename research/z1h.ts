/**
 * "Z on 1h" (owner's idea): the trigger stays v1.2's 4h signal (the edge's context), but the demand
 * zone, the limit fill and the stop use 1h candles — a finer, nearer zone than Z's 4h one.
 *
 *   zone    in the L 1h bars up to the signal's close: bar k whose close n bars later is ≥ rally
 *           above its own; the zone runs from the lowest low of bars k−3…k to bar k's body top;
 *           its top lo–hi under the signal close; the nearest one
 *   order   a limit at the zone's top on 1h bars after the signal, until v1.2's exit; stop 0.5% under
 *           the zone's low (skipped beyond 1–15%), checked on 1h bars from the fill bar on; out at
 *           v1.2's exit otherwise
 *   grid    L 30 / 50 / 80 · rally 4 / 6 / 8% · n 4 / 8 · distance 1–5% / 2–8%
 *   forms   replace Z (v1.2 0.75% + A + Z-1h 0.25%) · third leg (v1.2 0.5% + A + Z 0.25% + Z-1h
 *           0.25%) · gap-filler (v1.2 0.75% + A + Z 0.25% + Z-1h 0.25% only where Z had no zone)
 *
 * Against: v1.2 1% + A (today's live bot) and v1.2 0.75% + A + Z 0.25% (the paper bot). Cost 0.2%.
 * IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/z1h.ts
 */
import fs from "node:fs";
import path from "node:path";
import { limitFill, stopInRange, zoneOrder } from "../lib/setups/setupZ";
import type { Candle } from "../lib/types";
import { CACHE_DIR, type ResearchBar } from "./data";
import { loadSignals, trade, type Signal } from "./demand-entry";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { botTrades } from "./usdt-dominance";
import { SETUP_A } from "../lib/setups/setupA";
import type { AT } from "./audit";

const H1 = 3_600_000;
const H4 = 4 * H1;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);

interface Cell {
  L: number;
  rally: number;
  n: number;
  lo: number;
  hi: number;
}

async function main() {
  const { symbols, sigs } = await loadSignals();
  const hourly = new Map<string, { bars: ResearchBar[]; idx: Map<number, number> }>();
  for (const s of new Set(sigs.map((t) => t.symbol))) {
    const file = path.join(CACHE_DIR, "klines", "1h", `${s}.json`);
    if (!fs.existsSync(file)) continue;
    const bars: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    hourly.set(s, { bars, idx: new Map(bars.map((b, i) => [b.time * 1000, i])) });
  }

  const v1 = sigs.map((t) => trade(t.symbol, t.c, t.s, t.c[t.s].close, t.x, t.exit, t.liq, false));
  const { ac } = await botTrades(symbols);
  const accA = (t: Trade) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs;
  // Z on 4h (the paper bot), and the signals it had no zone for
  const z4: Trade[] = [];
  const noZone4 = new Set<Signal>();
  for (const t of sigs) {
    const order = zoneOrder(t.c as unknown as Candle[], t.s);
    if (!order) {
      noZone4.add(t);
      continue;
    }
    for (let f = t.s + 1; f <= t.x; f++) {
      const fill = limitFill(t.c[f] as unknown as Candle, order.level);
      if (fill === null) continue;
      if (stopInRange(fill, order.stop)) z4.push({ ...trade(t.symbol, t.c, f, fill, t.x, t.exit, t.liq, true, order.stop), symbol: `${t.symbol}#z` });
      break;
    }
  }

  /** Z-1h trades for one cell (and for the signals of `only`, when given). */
  const z1 = (p: Cell, only?: Set<Signal>): Trade[] => {
    const out: Trade[] = [];
    for (const t of sigs) {
      if (only && !only.has(t)) continue;
      const h = hourly.get(t.symbol);
      if (!h) continue;
      const close = t.c[t.s].close;
      const end = h.idx.get(t.c[t.s].time * 1000 + 3 * H1); // the 1h bar that closes with the signal bar
      const exitAt = h.idx.get(t.c[t.x].time * 1000 + 3 * H1); // …and with the exit bar
      if (end === undefined || exitAt === undefined) continue;
      const b = h.bars;
      let best: { lo: number; top: number } | null = null;
      for (let k = Math.max(3, end - p.L + 1); k + p.n <= end; k++) {
        if (b[k + p.n].close / b[k].close - 1 < p.rally) continue;
        const top = Math.max(b[k].open, b[k].close);
        if (!(top < close * (1 - p.lo) && top > close * (1 - p.hi)) || (best && top <= best.top)) continue;
        let lo = Infinity;
        for (let j = k - 3; j <= k; j++) lo = Math.min(lo, b[j].low);
        best = { lo, top };
      }
      if (!best) continue;
      const stop = best.lo * 0.995;
      for (let f = end + 1; f <= exitAt; f++) {
        if (b[f].low > best.top) continue;
        const fill = Math.min(b[f].open, best.top);
        if (!stopInRange(fill, stop)) break;
        let x = exitAt;
        let px = t.exit;
        for (let k = f; k <= exitAt; k++) {
          if (b[k].low <= stop) {
            x = k;
            px = k === f ? stop : Math.min(b[k].open, stop);
            break;
          }
        }
        const closes = b.slice(f, x + 1).map((y) => y.close);
        closes[0] = fill;
        closes[closes.length - 1] = px * 0.999;
        out.push({ symbol: `${t.symbol}#z1`, at: b[f].time * 1000 + H1, barMs: H1, entry: fill, stopDist: 1 - stop / fill, closes, exitBars: x - f, exit: px * 0.999, open: false, liquidity: t.liq, surge: 1, flow: 0, rs: 0, btcUp: null, fng: null });
        break;
      }
    }
    return out;
  };

  const sl = (ts: Trade[], risk: number, accept?: (t: Trade) => boolean): Sleeve => ({ trades: ts, accept, risk, maxFrac: 0.1, maxOpen: 15, maxBarRisk: Math.max(risk * 5, 0.0125) });
  const aS = sl(ac, 0.005, accA);
  aS.maxBarRisk = 0.025;
  const cal = (s: Sleeve[]) => [simulate(s, START, SPLIT), simulate(s, SPLIT, END)] as [Result, Result];
  const fmt = ([a, b]: [Result, Result]) => `${a.calmar.toFixed(2)} │ ${b.calmar.toFixed(2)} (${pct(a.cagr, 0)} / ${pct(a.maxDD, 0)} │ ${pct(b.cagr, 0)} / ${pct(b.maxDD, 0)})`;
  const perR = (xs: Trade[], from: number, to: number) => {
    const ys = xs.filter((t) => t.at >= from && t.at < to && t.liquidity >= 1e6);
    return { n: ys.length, r: ys.reduce((p, t) => p + (t.exit / t.entry - 1 - 0.001) / t.stopDist, 0) / Math.max(1, ys.length), stop: ys.map((t) => t.stopDist).sort((p, q) => p - q)[Math.floor(ys.length / 2)] ?? 0 };
  };

  const today = cal([sl(v1, 0.01), aS]);
  const paper = cal([sl(v1, 0.0075), aS, sl(z4, 0.0025)]);
  const z4r = [perR(z4, START, SPLIT), perR(z4, SPLIT, END)];
  console.log(`today (live): v1.2 1% + A ............. Calmar ${fmt(today)}`);
  console.log(`paper: v1.2 0.75% + A + Z 0.25% ........ Calmar ${fmt(paper)} · Z per trade ${z4r[0].r.toFixed(2)}R │ ${z4r[1].r.toFixed(2)}R (stop median ${pct(-z4r[0].stop, 1)})`);
  console.log(`signals without a 4h zone: ${noZone4.size} of ${sigs.length}\n`);
  console.log("GRID — Z-1h per trade IS │ OOS (n, stop median) · Calmar IS │ OOS: replace Z · third leg · gap-filler");
  let cells = 0;
  let rBoth = 0;
  const beat = { replace: 0, third: 0, gap: 0 };
  for (const L of [30, 50, 80]) {
    for (const rally of [0.04, 0.06, 0.08]) {
      for (const n of [4, 8]) {
        for (const [lo, hi] of [[0.01, 0.05], [0.02, 0.08]] as const) {
          const p: Cell = { L, rally, n, lo, hi };
          const z = z1(p);
          const zg = z1(p, noZone4);
          const a = perR(z, START, SPLIT);
          const b = perR(z, SPLIT, END);
          const rep = cal([sl(v1, 0.0075), aS, sl(z, 0.0025)]);
          const third = cal([sl(v1, 0.005), aS, sl(z4, 0.0025), sl(z, 0.0025)]);
          const gap = cal([sl(v1, 0.0075), aS, sl(z4, 0.0025), sl(zg, 0.0025)]);
          cells++;
          if (a.r > 0 && b.r > 0) rBoth++;
          const better = (x: [Result, Result]) => x[0].calmar > paper[0].calmar && x[1].calmar > paper[1].calmar;
          if (better(rep)) beat.replace++;
          if (better(third)) beat.third++;
          if (better(gap)) beat.gap++;
          console.log(
            `  L${String(L).padStart(2)} · ${rally * 100}% in ${n} · ${lo * 100}–${hi * 100}%  ${a.r.toFixed(2).padStart(5)}R │ ${b.r.toFixed(2).padStart(5)}R (${a.n}│${b.n}, ${pct(-a.stop, 1)}) · ${rep[0].calmar.toFixed(2)} │ ${rep[1].calmar.toFixed(2)} · ${third[0].calmar.toFixed(2)} │ ${third[1].calmar.toFixed(2)} · ${gap[0].calmar.toFixed(2)} │ ${gap[1].calmar.toFixed(2)}`,
          );
        }
      }
    }
  }
  console.log(`\n  ${cells} cells: Z-1h per trade > 0 in both periods ${rBoth} · beats the paper bot's Calmar in both — replace ${beat.replace} · third leg ${beat.third} · gap-filler ${beat.gap}`);
}

if (process.argv[1]?.endsWith("z1h.ts")) void main();
