/**
 * Smaller losses, bigger wins: which entries get stopped out, and do tighter stops,
 * breakeven stops or better entries help Setup v1.2 and Setup A?
 *
 * 1. Diagnosis on the validated trades (v1.2: breadth ≥ 10; A: volume-confirmed; ≥ $1M/day):
 *    stop rate and return by entry feature, how deep winners dip first (MAE), and how far
 *    stopped trades ran first (MFE).
 * 2. Experiments: entry variant × initial stop × breakeven, each setup in its own bot-like
 *    portfolio (v1: 1% risk, ≤ 5% per bar; A: 0.5% risk, ≤ 2.5% per bar; ≤ 15 open, ≤ 10% a
 *    position). Chosen on in-sample only; out-of-sample reported.
 *
 *   npx tsx research/stops.ts
 */
import fs from "node:fs";
import path from "node:path";
import { computeMaxFlow } from "../lib/maxflow";
import { SETUP_A, atr, runSetupA, volumeSurge } from "../lib/setups/setupA";
import { SETUP_V1, biasTimeframe, liquidity30d, runSetupV1, stochastic } from "../lib/setups/setupV1";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { compare, header, loadContext, pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const COST = SETUP_V1.cost;

/* ───────────────────────────── per-pair arrays ───────────────────────────── */

export interface Arrays {
  green: Uint8Array; // green dot known on this bar
  firstRed: Uint8Array; // first red dot known on this bar
  wtDown: Uint8Array; // any bearish WaveTrend cross (any level), known on this bar
  stochDown: Uint8Array; // stoch 5,3,3 or 14,3,3 crosses down from above 80
  trigger: Uint8Array; // stoch 5,3,3 or 14,3,3 crosses up from below 20
  atr: number[];
  hh: number[]; // highest high of the 120 bars before
  ema200: number[];
}

export function arrays(c: ResearchBar[]): Arrays {
  const n = c.length;
  const mf = computeMaxFlow(c, {
    scalping: false, obosFilter: true, divergence: false, hiddenDivergence: false, mtf: true, htfMs: biasTimeframe(H4), intervalMs: H4,
    dynamicBands: false, atrLength: 14, volumeArea: false, earlyWarning: false, mfLength: 14, mfSmooth: 3, vwapLength: 8,
  });
  const green = new Uint8Array(n);
  for (const d of mf.dots) if (d.kind === "green" && d.index + 1 < n) green[d.index + 1] = 1;
  const firstRed = new Uint8Array(n);
  const wtDown = new Uint8Array(n);
  for (let i = 1; i + 1 < n; i++) {
    if (!(mf.wt1[i] < mf.wt2[i] && mf.wt1[i - 1] >= mf.wt2[i - 1])) continue;
    wtDown[i + 1] = 1;
    if (mf.wt1[i] > 0) firstRed[i + 1] = 1;
  }
  const fast = stochastic(c, 5, 3, 3);
  const slow = stochastic(c, 14, 3, 3);
  const up = (s: { k: number[]; d: number[] }, i: number) => s.k[i] > s.d[i] && s.k[i - 1] <= s.d[i - 1] && Math.min(s.k[i - 1], s.d[i - 1]) < 20;
  const down = (s: { k: number[]; d: number[] }, i: number) => s.k[i] < s.d[i] && s.k[i - 1] >= s.d[i - 1] && Math.max(s.k[i - 1], s.d[i - 1]) > 80;
  const trigger = new Uint8Array(n);
  const stochDown = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    if (up(fast, i) || up(slow, i)) trigger[i] = 1;
    if (down(fast, i) || down(slow, i)) stochDown[i] = 1;
  }
  const hh = new Array<number>(n).fill(Number.NaN);
  const dq: number[] = [];
  let head = 0;
  for (let i = 0; i < n; i++) {
    while (head < dq.length && dq[head] < i - SETUP_A.lookback) head++;
    if (i >= SETUP_A.lookback) hh[i] = c[dq[head]].high;
    while (dq.length > head && c[dq[dq.length - 1]].high <= c[i].high) dq.pop();
    dq.push(i);
  }
  const ema200: number[] = [];
  let e = c[0].close;
  for (const b of c) ema200.push((e = (2 / 201) * b.close + (1 - 2 / 201) * e));
  return { green, firstRed, wtDown, stochDown, trigger, atr: atr(c, SETUP_A.atrLength), hh, ema200 };
}

/* ───────────────────────────── trades ───────────────────────────── */

type Reason = "stop" | "signal" | "trail" | "breakeven" | "end";

interface XTrade extends Trade {
  reason: Reason;
  mae: number; // worst low vs entry while held
  mfe: number; // best high vs entry while held
  breadth: number; // v1: pairs signalling on the signal bar (base signals)
  passes: boolean; // A: volume confirmation
  f: Record<string, number>; // entry features
}

interface Exit {
  /** Initial stop distance (fraction of the entry). */
  stopDist: number;
  /** Move the stop to entry + costs once the high reaches entry × (1 + this × stopDist); 0 = off. */
  breakevenR: number;
  /** "red": first red dot (v1). "chandelier": highest close − 8×ATR (A). */
  kind: "red" | "chandelier";
}

function hold(c: ResearchBar[], a: Arrays, s: number, x: Exit) {
  const entry = c[s].close;
  let stop = entry * (1 - x.stopDist);
  let moved = false;
  const closes = [entry];
  let best = entry;
  let mae = 0;
  let mfe = 0;
  for (let i = s + 1; i < c.length; i++) {
    const bar = c[i];
    mae = Math.min(mae, bar.low / entry - 1);
    if (bar.low <= stop) {
      const px = Math.min(bar.open, stop);
      closes.push(px);
      return { closes, exitBars: i - s, exit: px, open: false, reason: (moved ? "breakeven" : "stop") as Reason, mae, mfe };
    }
    mfe = Math.max(mfe, bar.high / entry - 1);
    closes.push(bar.close);
    const exitNow = x.kind === "red" ? a.firstRed[i] === 1 : bar.close < best - SETUP_A.atrMult * a.atr[i - 1];
    if (exitNow) return { closes, exitBars: i - s, exit: bar.close, open: false, reason: (x.kind === "red" ? "signal" : "trail") as Reason, mae, mfe };
    best = Math.max(best, bar.close);
    // Effective from the next bar: within a bar the order of high and low is unknown.
    if (x.breakevenR > 0 && !moved && bar.high >= entry * (1 + x.breakevenR * x.stopDist)) {
      stop = Math.max(stop, entry * (1 + 2 * COST));
      moved = true;
    }
  }
  return { closes, exitBars: closes.length - 1, exit: c[c.length - 1].close, open: true, reason: "end" as Reason, mae, mfe };
}

type V1Entry = "base" | "laterDot" | "laterDotHL" | "firstDot" | "confirm";
type V1Stop = { label: string; dist: (c: ResearchBar[], a: Arrays, s: number) => number };
type AEntry = "base" | "notExtended" | "confirm";

interface PairCtx {
  symbol: string;
  c: ResearchBar[];
  a: Arrays;
  btcRet30: (t: number) => number;
  fng: (t: number) => number | null;
}

function features(p: PairCtx, s: number) {
  const { c, a } = p;
  let hi30 = 0;
  for (let j = Math.max(0, s - 30); j <= s; j++) hi30 = Math.max(hi30, c[j].high);
  let dots = 0;
  for (let j = Math.max(0, s - 30); j < s - SETUP_V1.dotWindow; j++) dots += a.green[j];
  const own30 = s >= 180 ? c[s].close / c[s - 180].close - 1 : 0;
  const at = c[s].time * 1000 + H4;
  return {
    depth: c[s].close / hi30 - 1, // drop from the 30-bar high
    priorDots: dots, // green dots in the 30 bars before the current dot window
    atrPct: a.atr[s] / c[s].close,
    ema200: c[s].close / a.ema200[s] - 1,
    ext: c[s].close / a.hh[s] - 1, // A: how far above the 20-day high
    barRange: (c[s].high - c[s].low) / c[s].close,
    rs: own30 - p.btcRet30(at),
    fng: p.fng(at) ?? 50,
  };
}

/** The earlier green dot (bar index) in the 30 bars before the current dot window, or −1. */
function earlierDot(a: Arrays, s: number): number {
  for (let j = s - SETUP_V1.dotWindow - 1; j >= Math.max(0, s - 30); j--) if (a.green[j]) return j;
  return -1;
}

function v1Trades(p: PairCtx, entry: V1Entry, stop: V1Stop, breakevenR: number, breadthAt: Map<number, number>): XTrade[] {
  const { c, a, symbol } = p;
  const out: XTrade[] = [];
  for (let s = SETUP_V1.warmup; s < c.length; s++) {
    let dot = false;
    for (let j = s; j >= s - SETUP_V1.dotWindow; j--) if (a.green[j]) dot = true;
    if (!dot || !a.trigger[s]) continue;
    const signalAt = c[s].time * 1000 + H4;
    let e = s;
    if (entry === "laterDot" || entry === "firstDot") {
      const later = earlierDot(a, s) >= 0;
      if ((entry === "laterDot") !== later) continue;
    } else if (entry === "laterDotHL") {
      const j = earlierDot(a, s);
      if (j < 0) continue;
      let lowThen = Number.POSITIVE_INFINITY;
      for (let k = Math.max(0, j - 3); k <= j; k++) lowThen = Math.min(lowThen, c[k].low);
      let lowNow = Number.POSITIVE_INFINITY;
      for (let k = s - SETUP_V1.dotWindow; k <= s; k++) lowNow = Math.min(lowNow, c[k].low);
      if (lowNow <= lowThen) continue; // a higher low (bullish divergence) only
    } else if (entry === "confirm") {
      // Enter one bar later, only if it closes above the signal bar's high.
      if (s + 1 >= c.length || c[s + 1].close <= c[s].high) continue;
      e = s + 1;
    }
    const stopDist = Math.min(SETUP_V1.stopPct, stop.dist(c, a, e));
    // breakevenR ≥ 1: R multiples; below 1: a price move (e.g. 0.03 = +3%).
    const h = hold(c, a, e, { stopDist, breakevenR: breakevenR >= 1 ? breakevenR : breakevenR / stopDist, kind: "red" });
    out.push({
      symbol, at: c[e].time * 1000 + H4, barMs: H4, entry: c[e].close, stopDist, ...h,
      liquidity: liquidity30d(c, e, H4), surge: 1, flow: 0, rs: 0, btcUp: null, fng: null,
      breadth: breadthAt.get(signalAt) ?? 0, passes: true, f: features(p, s),
    });
    if (h.open) break;
    s = e + h.exitBars;
  }
  return out;
}

function aTrades(p: PairCtx, entry: AEntry, stopK: number, breakevenR: number): XTrade[] {
  const { c, a, symbol } = p;
  const out: XTrade[] = [];
  for (let s = SETUP_A.warmup; s < c.length; s++) {
    if (!(c[s].close > a.hh[s] && c[s - 1].close <= a.hh[s - 1])) continue;
    if ((SETUP_A.atrMult * a.atr[s]) / c[s].close > SETUP_A.maxStopPct) continue;
    const surge = volumeSurge(c, s, H4);
    const f = features(p, s);
    let e = s;
    if (entry === "notExtended" && f.ext > 0.03) continue;
    if (entry === "confirm") {
      if (s + 1 >= c.length || c[s + 1].close <= c[s].close) continue;
      e = s + 1;
    }
    const stopDist = (stopK * a.atr[e]) / c[e].close;
    const h = hold(c, a, e, { stopDist, breakevenR, kind: "chandelier" });
    out.push({
      symbol, at: c[e].time * 1000 + H4, barMs: H4, entry: c[e].close, stopDist, ...h,
      liquidity: liquidity30d(c, e, H4), surge, flow: 0, rs: f.rs, btcUp: null, fng: f.fng,
      breadth: 0, passes: surge >= SETUP_A.minSurge, f,
    });
    if (h.open) break;
    s = e + h.exitBars;
  }
  return out;
}

/* ───────────────────────────── report helpers ───────────────────────────── */

const net = (t: XTrade) => t.exit / t.entry - 1 - COST - (t.liquidity < 5e6 ? 0.002 : 0);
const inIS = (t: Trade) => t.at >= START && t.at < SPLIT;
const inOOS = (t: Trade) => t.at >= SPLIT;

function buckets(title: string, trades: XTrade[], feats: [string, (t: XTrade) => number, number[]][]) {
  console.log(`\n${title}: stop-out rate and average net return by entry feature (IS │ OOS)`);
  for (const [label, f, cuts] of feats) {
    const cells: string[] = [];
    for (let b = 0; b <= cuts.length; b++) {
      const lo = b === 0 ? Number.NEGATIVE_INFINITY : cuts[b - 1];
      const hi = b === cuts.length ? Number.POSITIVE_INFINITY : cuts[b];
      const cell = (xs: XTrade[]) => {
        const ys = xs.filter((t) => f(t) >= lo && f(t) < hi);
        if (!ys.length) return "–";
        const stops = ys.filter((t) => t.reason === "stop").length;
        return `${String(ys.length).padStart(3)} stop ${((100 * stops) / ys.length).toFixed(0).padStart(2)}% ${pct(ys.reduce((s, t) => s + net(t), 0) / ys.length, 1).padStart(6)}`;
      };
      const range = b === 0 ? `<${cuts[0]}` : b === cuts.length ? `≥${cuts.at(-1)}` : `${lo}…${hi}`;
      cells.push(`${range.padEnd(10)} ${cell(trades.filter(inIS))} │ ${cell(trades.filter(inOOS))}`);
    }
    console.log(`  ${label}`);
    for (const cell of cells) console.log(`      ${cell}`);
  }
}

function excursions(title: string, trades: XTrade[]) {
  const winners = trades.filter((t) => net(t) > 0);
  const stopped = trades.filter((t) => t.reason === "stop");
  const share = (xs: XTrade[], f: (t: XTrade) => boolean) => `${((100 * xs.filter(f).length) / Math.max(1, xs.length)).toFixed(0)}%`;
  console.log(`\n${title}: ${trades.length} trades · ${winners.length} winners · ${stopped.length} stopped (${share(trades, (t) => t.reason === "stop")})`);
  console.log(`  winners that first dipped below:  −3% ${share(winners, (t) => t.mae < -0.03)} · −5% ${share(winners, (t) => t.mae < -0.05)} · −8% ${share(winners, (t) => t.mae < -0.08)} · −10% ${share(winners, (t) => t.mae < -0.1)} · −12% ${share(winners, (t) => t.mae < -0.12)}`);
  console.log(`  stopped trades that first rose:   +2% ${share(stopped, (t) => t.mfe > 0.02)} · +3% ${share(stopped, (t) => t.mfe > 0.03)} · +5% ${share(stopped, (t) => t.mfe > 0.05)} · +8% ${share(stopped, (t) => t.mfe > 0.08)}`);
  const lossSum = trades.filter((t) => net(t) < 0).reduce((s, t) => s + net(t), 0);
  console.log(`  share of all losses from stop-outs: ${((100 * stopped.reduce((s, t) => s + net(t), 0)) / Math.min(-1e-9, lossSum)).toFixed(0)}%`);
}

/* ───────────────────────────── main ───────────────────────────── */

async function main() {
  const ctx = await loadContext();
  const pairs: PairCtx[] = [];
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")), 3 * DAY)) {
      if (c.length < SETUP_V1.warmup + 30) continue;
      pairs.push({ symbol, c, a: arrays(c), btcRet30: ctx.btcRet30, fng: ctx.fng });
    }
  }

  // Base v1 signals → breadth per signal bar; and a fidelity check against the shared engines.
  const fixed = (d: number): V1Stop => ({ label: `−${d * 100}%`, dist: () => d });
  const base: XTrade[] = pairs.flatMap((p) => v1Trades(p, "base", fixed(SETUP_V1.stopPct), 0, new Map()));
  const breadthAt = new Map<number, number>();
  for (const t of base) breadthAt.set(t.at, (breadthAt.get(t.at) ?? 0) + 1);
  let engineV1 = 0;
  let engineA = 0;
  for (const p of pairs) {
    const r = runSetupV1(p.c, { stoch: "either", intervalMs: H4 });
    engineV1 += r.trades.length + (r.open ? 1 : 0);
    const q = runSetupA(p.c, H4);
    engineA += q.trades.length + (q.open ? 1 : 0);
  }
  const baseA = pairs.flatMap((p) => aTrades(p, "base", SETUP_A.atrMult, 0));
  console.log(`fidelity: v1 ${base.length} trades vs engine ${engineV1} · A ${baseA.length} vs engine ${engineA}`);

  /* 1. Diagnosis */
  const v12 = pairs.flatMap((p) => v1Trades(p, "base", fixed(SETUP_V1.stopPct), 0, breadthAt)).filter((t) => t.breadth >= 10 && t.liquidity >= 1e6 && !t.open);
  const a = baseA.filter((t) => t.passes && t.liquidity >= 1e6 && !t.open);
  excursions("v1.2 trades (breadth ≥ 10)", v12);
  buckets("v1.2", v12, [
    ["green dots in the 30 bars before (0 = first dot of the drop)", (t) => t.f.priorDots, [1, 2]],
    ["drop from the 30-bar high", (t) => t.f.depth, [-0.3, -0.2, -0.12]],
    ["volatility ATR/price", (t) => t.f.atrPct, [0.02, 0.03, 0.05]],
    ["price vs EMA200 (4h)", (t) => t.f.ema200, [-0.2, -0.1, 0]],
    ["breadth", (t) => t.breadth, [15, 25, 40]],
  ]);
  excursions("Setup A trades (volume-confirmed)", a);
  buckets("Setup A", a, [
    ["close above the 20-day high", (t) => t.f.ext, [0.01, 0.03, 0.06]],
    ["stop distance (8×ATR)", (t) => t.stopDist, [0.15, 0.2, 0.23]],
    ["breakout bar range", (t) => t.f.barRange, [0.03, 0.06, 0.1]],
    ["RS vs BTC 30d", (t) => t.f.rs, [-0.1, 0, 0.2]],
    ["Fear & Greed", (t) => t.f.fng, [25, 50, 75]],
  ]);

  /* 2. Experiments */
  const v1Sleeve = (trades: XTrade[]): Sleeve => ({ trades, accept: (t) => (t as XTrade).breadth >= 10, risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 });
  const aSleeve = (trades: XTrade[]): Sleeve => ({ trades, accept: (t) => (t as XTrade).passes, risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025 });
  const stops: V1Stop[] = [fixed(0.15), fixed(0.12), fixed(0.1), fixed(0.08), { label: "6×ATR (≤15%)", dist: (c, ar, s) => (6 * ar.atr[s]) / c[s].close }, { label: "4×ATR (≤15%)", dist: (c, ar, s) => (4 * ar.atr[s]) / c[s].close }];

  const grid1: { name: string; sleeve: Sleeve; is: Result }[] = [];
  header("v1.2 · entry × stop × breakeven (1% risk sized to the stop, ≤ 5% per bar)");
  for (const entry of ["base", "laterDot", "laterDotHL", "firstDot", "confirm"] as V1Entry[])
    for (const stop of stops)
      // Breakeven trigger as a price move: +3%, +5%, +8% or +1R (= the stop distance).
      for (const be of [0, 0.03, 0.05, 0.08, 1]) {
        if (entry !== "base" && (stop.label === "−12%" || stop.label === "4×ATR (≤15%)")) continue;
        if (be > 0 && be < 1 && !((entry === "base" || entry === "firstDot") && (stop.label === "−15%" || stop.label.startsWith("6×")))) continue;
        const trades = pairs.flatMap((p) => v1Trades(p, entry, stop, be, breadthAt));
        const name = `${entry} · stop ${stop.label}${be === 1 ? " · BE at +1R" : be ? ` · BE at +${be * 100}%` : ""}`;
        grid1.push({ name, sleeve: v1Sleeve(trades), is: compare(name, [v1Sleeve(trades)], entry === "base" && stop.label === "−15%" && !be ? "= " : "  ") });
      }
  const pick1 = [...grid1].sort((x, y) => y.is.calmar - x.is.calmar)[0];
  console.log(`  ★ in-sample pick: ${pick1.name}   ("= " marks v1.2 today)`);

  const grid2: { name: string; sleeve: Sleeve; is: Result }[] = [];
  header("Setup A · entry × initial stop × breakeven (0.5% risk sized to the stop; trail stays 8×ATR)");
  for (const entry of ["base", "notExtended", "confirm"] as AEntry[])
    for (const k of [8, 6, 5, 4])
      for (const be of [0, 1, 2]) {
        const trades = pairs.flatMap((p) => aTrades(p, entry, k, be));
        const name = `${entry} · stop ${k}×ATR${be ? ` · BE at +${be}R` : ""}`;
        grid2.push({ name, sleeve: aSleeve(trades), is: compare(name, [aSleeve(trades)], entry === "base" && k === 8 && !be ? "= " : "  ") });
      }
  const pick2 = [...grid2].sort((x, y) => y.is.calmar - x.is.calmar)[0];
  console.log(`  ★ in-sample pick: ${pick2.name}   ("= " marks Setup A today)`);

  header("COMBINED (shared capital): today vs the in-sample picks");
  const today1 = grid1.find((g) => g.name === "base · stop −15%")!.sleeve;
  const today2 = grid2.find((g) => g.name === "base · stop 8×ATR")!.sleeve;
  compare("v1.2 + A today", [today1, today2], "= ");
  compare("picked v1 + A today", [pick1.sleeve, today2]);
  compare("v1.2 today + picked A", [today1, pick2.sleeve]);
  compare("picked v1 + picked A", [pick1.sleeve, pick2.sleeve]);

  console.log(`\nPER YEAR: today │ picked v1 + picked A`);
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    const f = (s: Sleeve[]) => {
      const r = simulate(s, from, to);
      return `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} (${r.trades} tr, win ${(100 * r.win).toFixed(0)}%)`;
    };
    console.log(`  ${y}  ${f([today1, today2]).padEnd(42)} │ ${f([pick1.sleeve, pick2.sleeve])}`);
  }
}

if (process.argv[1]?.endsWith("stops.ts")) void main();
