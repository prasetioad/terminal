/**
 * Setup v1.1 upgrade research: more opportunities, less risk, more profit?
 *
 *   npx tsx research/variants.ts            (uses the research cache; run setup-v1.ts first)
 *
 * Builds one dataset of Setup v1 trades (and stochastic-only candidates, H8) over the
 * survivorship-free universe with entry features and price paths, then simulates
 * bot-like portfolios marked to market every 4h bar. Variants are chosen on the
 * in-sample period only and compared out-of-sample (docs/ROADMAP.md §2).
 */
import fs from "node:fs";
import path from "node:path";
import { computeMaxFlow } from "../lib/maxflow";
import { SETUP_V1, biasTimeframe, liquidity30d, runSetupV1, stochastic } from "../lib/setups/setupV1";
import { CACHE_DIR, archiveSymbols, loadSeries, segments, type ResearchBar } from "./data";
import { inUniverse } from "./universe";

const BAR = SETUP_V1.validatedInterval;
const DAY = 86_400_000;
const SPLIT = Date.UTC(2024, 6, 1);
const START = Date.UTC(2021, 0, 1);

/* ───────────────────────────── dataset ───────────────────────────── */

export interface Candidate {
  symbol: string;
  kind: "v1" | "stoch"; // Setup v1 entry, or a stochastic-only entry (H8)
  entryTime: number;
  entryPrice: number;
  /** Closes from the entry bar to the exit bar (marking), and the two exits. */
  closes: number[];
  exitT1: { bars: number; price: number; reason: "signal" | "stop" };
  exitT4: { bars: number; price: number }; // after the first red dot, trail the 10-bar low
  liquidity: number;
  drawdown30: number; // close vs the 30-bar high (negative)
  stochK: number; // fastest %K at the cross bar's previous bar
  vsEma200: number; // close vs EMA200 (4h)
}

function ema(values: number[], n: number): number[] {
  const a = 2 / (n + 1);
  const out: number[] = [];
  let p = Number.NaN;
  for (const v of values) out.push((p = Number.isNaN(p) ? v : a * v + (1 - a) * p));
  return out;
}

/** Simulate one position from `s`: −15% stop, T1 exit at the first red dot, T4 trail after it. */
function simulate(bars: ResearchBar[], s: number, firstRed: Uint8Array): Pick<Candidate, "closes" | "exitT1" | "exitT4"> | null {
  const entry = bars[s].close;
  const stop = entry * (1 - SETUP_V1.stopPct);
  let t1: Candidate["exitT1"] | null = null;
  let t4: Candidate["exitT4"] | null = null;
  let armed = false;
  const closes = [entry];
  for (let x = s + 1; x < bars.length; x++) {
    closes.push(bars[x].close);
    const b = bars[x];
    if (!t1) {
      if (b.low <= stop) t1 = { bars: x - s, price: stop, reason: "stop" };
      else if (firstRed[x]) t1 = { bars: x - s, price: b.close, reason: "signal" };
    }
    if (!t4) {
      let trail = Number.POSITIVE_INFINITY;
      for (let j = Math.max(s + 1, x - 10); j < x; j++) trail = Math.min(trail, bars[j].low);
      if (b.low <= stop) t4 = { bars: x - s, price: stop };
      else if (armed && b.low <= trail) t4 = { bars: x - s, price: trail };
      if (firstRed[x]) armed = true;
    }
    if (t1 && t4) return { closes, exitT1: t1, exitT4: t4 };
  }
  return null; // still open at the end of the data
}

async function buildDataset(): Promise<Candidate[]> {
  const file = path.join(CACHE_DIR, "variants-dataset.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const out: Candidate[] = [];
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const all = await loadSeries(symbol, "4h", 2021);
    for (const bars of segments(all, 3 * DAY)) {
      if (bars.length < SETUP_V1.warmup + 30) continue;
      const n = bars.length;
      const mf = computeMaxFlow(bars, { scalping: false, obosFilter: true, divergence: false, hiddenDivergence: false, mtf: true, htfMs: biasTimeframe(BAR), intervalMs: BAR, dynamicBands: false, atrLength: 14, volumeArea: false, earlyWarning: false, mfLength: 14, mfSmooth: 3, vwapLength: 8 });
      const firstRed = new Uint8Array(n);
      for (let i = 1; i + 1 < n; i++) if (mf.wt1[i] < mf.wt2[i] && mf.wt1[i - 1] >= mf.wt2[i - 1] && mf.wt1[i] > 0) firstRed[i + 1] = 1;
      const fast = stochastic(bars, 5, 3, 3);
      const slow = stochastic(bars, 14, 3, 3);
      const up = (st: { k: number[]; d: number[] }, i: number) => st.k[i] > st.d[i] && st.k[i - 1] <= st.d[i - 1] && Math.min(st.k[i - 1], st.d[i - 1]) < 20;
      const e200 = ema(bars.map((b) => b.close), 200);
      const features = (s: number) => {
        let hh = 0;
        for (let j = Math.max(0, s - 29); j <= s; j++) hh = Math.max(hh, bars[j].high);
        return {
          liquidity: liquidity30d(bars, s, BAR),
          drawdown30: bars[s].close / hh - 1,
          stochK: Math.min(fast.k[s - 1], slow.k[s - 1]),
          vsEma200: bars[s].close / e200[s] - 1,
        };
      };
      const push = (kind: Candidate["kind"], s: number) => {
        const sim = simulate(bars, s, firstRed);
        if (sim) out.push({ symbol, kind, entryTime: bars[s].time * 1000, entryPrice: bars[s].close, ...sim, ...features(s) });
        return sim;
      };
      // Setup v1 entries: exactly the shared engine's (one position at a time).
      for (const t of runSetupV1(bars, { stoch: "either", intervalMs: BAR }).trades) push("v1", t.entryIndex);
      // H8: stochastic-only entries (no MaxFlow dot), one position at a time, same exits.
      let s = SETUP_V1.warmup;
      while (s < n - 1) {
        if (!(up(fast, s) || up(slow, s))) {
          s++;
          continue;
        }
        const sim = push("stoch", s);
        if (!sim) break;
        s += sim.exitT1.bars + 1;
      }
    }
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/* ───────────────────────────── portfolio ───────────────────────────── */

export interface Variant {
  name: string;
  kind: Candidate["kind"];
  minBreadth: number;
  minLiquidity: number;
  /** Equity at risk (lost at the −15% stop) per position, given the bar's breadth. */
  risk: (breadth: number) => number;
  maxOpen: number;
  /** Cap on the summed risk of positions opened on one bar (they are one correlated bet). */
  maxBarRisk: number;
  order: "liquidity" | "drawdown" | "stoch";
  exit: "T1" | "T4";
  btcFilter: "none" | "above200" | "below200";
  /** Extra filter on the entry features. */
  filter?: (c: Candidate) => boolean;
}

export interface Result {
  trades: number;
  perYear: number;
  win: number;
  avg: number; // net return per trade
  cagr: number;
  maxDD: number; // mark-to-market, every 4h bar
  calmar: number;
  exposure: number; // average fraction of equity invested
}

const cost = (c: Candidate) => SETUP_V1.cost + (c.liquidity < 5e6 ? 0.002 : 0); // thin pairs slip more

export function simulatePortfolio(cands: Candidate[], v: Variant, from: number, to: number, btcAbove: (t: number) => boolean | null): Result {
  const pool = cands.filter((c) => c.kind === v.kind && c.entryTime >= from && c.entryTime < to);
  const breadthOf = new Map<number, number>();
  for (const c of pool) breadthOf.set(c.entryTime, (breadthOf.get(c.entryTime) ?? 0) + 1);
  const byBar = new Map<number, Candidate[]>();
  for (const c of pool) {
    const breadth = breadthOf.get(c.entryTime)!;
    if (breadth < v.minBreadth || c.liquidity < v.minLiquidity) continue;
    if (v.filter && !v.filter(c)) continue;
    if (v.btcFilter !== "none") {
      const above = btcAbove(c.entryTime);
      if (above === null || (v.btcFilter === "above200") !== above) continue;
    }
    (byBar.get(c.entryTime) ?? byBar.set(c.entryTime, []).get(c.entryTime)!).push(c);
  }
  const key = { liquidity: (c: Candidate) => -c.liquidity, drawdown: (c: Candidate) => c.drawdown30, stoch: (c: Candidate) => c.stochK }[v.order];

  type Open = { qty: number; c: Candidate; bars: number; exitPrice: number; age: number };
  let cash = 1;
  let open: Open[] = [];
  let peak = 1;
  let maxDD = 0;
  let taken = 0;
  let wins = 0;
  let sumRet = 0;
  let exposureSum = 0;
  let steps = 0;
  for (let t = from; t < to; t += BAR) {
    // advance: close positions whose exit bar is reached
    for (const o of open) o.age++;
    for (const o of open.filter((o) => o.age >= o.bars)) {
      const ret = o.exitPrice / o.c.entryPrice - 1 - cost(o.c);
      cash += o.qty * o.c.entryPrice * (1 + ret);
      taken++;
      sumRet += ret;
      if (ret > 0) wins++;
    }
    open = open.filter((o) => o.age < o.bars);
    // mark to market
    const value = (o: Open) => o.qty * o.c.closes[Math.min(o.age, o.c.closes.length - 1)];
    let equity = cash + open.reduce((s, o) => s + value(o), 0);
    // entries on this bar
    const list = (byBar.get(t) ?? []).sort((a, b) => key(a) - key(b));
    let barRisk = 0;
    for (const c of list) {
      if (open.length >= v.maxOpen) break;
      const r = v.risk(breadthOf.get(t)!);
      if (barRisk + r > v.maxBarRisk + 1e-12) break;
      const quote = Math.min((equity * r) / SETUP_V1.stopPct, cash * 0.98);
      if (quote <= equity * 0.001) break;
      cash -= quote;
      barRisk += r;
      const exit = v.exit === "T1" ? c.exitT1 : c.exitT4;
      open.push({ qty: quote / c.entryPrice, c, bars: exit.bars, exitPrice: exit.price, age: 0 });
    }
    equity = cash + open.reduce((s, o) => s + value(o), 0);
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity / peak - 1);
    exposureSum += (equity - cash) / equity;
    steps++;
  }
  const equity = cash + open.reduce((s, o) => s + o.qty * o.c.closes[Math.min(o.age, o.c.closes.length - 1)], 0);
  const years = (to - from) / (365.25 * DAY);
  const cagr = Math.pow(equity, 1 / years) - 1;
  return { trades: taken, perYear: taken / years, win: taken ? wins / taken : 0, avg: taken ? sumRet / taken : 0, cagr, maxDD, calmar: maxDD < 0 ? cagr / -maxDD : 0, exposure: exposureSum / steps };
}

/* ───────────────────────────── experiment ───────────────────────────── */

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}%`;
const line = (r: Result) =>
  `${String(r.trades).padStart(4)} tr (${r.perYear.toFixed(0).padStart(3)}/yr) win ${(100 * r.win).toFixed(0)}% avg ${pct(r.avg, 2).padStart(7)} · CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Calmar ${r.calmar.toFixed(2).padStart(5)} · exp ${(100 * r.exposure).toFixed(0)}%`;

async function main() {
  const cands = await buildDataset();
  const btc = (await loadSeries("BTCUSDT", "4h", 2021)).map((b) => ({ t: b.time * 1000, c: b.close }));
  const sma: number[] = [];
  let sum = 0;
  const N = 1200; // 200 days of 4h bars
  btc.forEach((b, i) => {
    sum += b.c;
    if (i >= N) sum -= btc[i - N].c;
    sma.push(i >= N - 1 ? sum / N : Number.NaN);
  });
  const btcAbove = (t: number) => {
    let lo = 0;
    let hi = btc.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (btc[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return Number.isNaN(sma[lo]) ? null : btc[lo].c > sma[lo];
  };
  console.log(`dataset: ${cands.filter((c) => c.kind === "v1").length} Setup v1 entries · ${cands.filter((c) => c.kind === "stoch").length} stochastic-only entries`);

  const base: Variant = { name: "v1.1 (bot today)", kind: "v1", minBreadth: 10, minLiquidity: 1e6, risk: () => 0.01, maxOpen: 15, maxBarRisk: 1, order: "liquidity", exit: "T1", btcFilter: "none" };
  const variants: Variant[] = [
    base,
    // H1 lower breadth
    { ...base, name: "H1 breadth ≥5", minBreadth: 5 },
    { ...base, name: "H1 breadth ≥7", minBreadth: 7 },
    { ...base, name: "H1 breadth ≥5 + drawdown ≤ −20%", minBreadth: 5, filter: (c) => c.drawdown30 <= -0.2 },
    // H2 selection inside an event
    { ...base, name: "H2 pick deepest drawdown", order: "drawdown" },
    { ...base, name: "H2 pick lowest stoch", order: "stoch" },
    // H3 size with breadth
    { ...base, name: "H3 risk 0.5/1/1.5% by breadth 10/25/40", risk: (b) => (b >= 40 ? 0.015 : b >= 25 ? 0.01 : 0.005) },
    // H4 more, smaller slots
    { ...base, name: "H4 0.5% risk × 30 slots", risk: () => 0.005, maxOpen: 30 },
    { ...base, name: "H4 0.33% risk × 45 slots", risk: () => 0.0033, maxOpen: 45 },
    // H5 cap per event
    { ...base, name: "H5 0.5% × 30, ≤ 5% risk per bar", risk: () => 0.005, maxOpen: 30, maxBarRisk: 0.05 },
    // H6 longer exits in capitulation
    { ...base, name: "H6 exit T4 (trail after 1st red)", exit: "T4" },
    // H7 BTC regime
    { ...base, name: "H7 only BTC above 200D", btcFilter: "above200" },
    { ...base, name: "H7 only BTC below 200D", btcFilter: "below200" },
    // H8 stochastic-only breadth
    { ...base, name: "H8 stoch-only, breadth ≥10", kind: "stoch" },
    { ...base, name: "H8 stoch-only, breadth ≥20", kind: "stoch", minBreadth: 20 },
    { ...base, name: "H8 stoch-only, breadth ≥40", kind: "stoch", minBreadth: 40 },
  ];
  console.log(`\n${"variant".padEnd(40)} ${"IN-SAMPLE 2021-01 → 2024-06".padEnd(96)} | OUT-OF-SAMPLE 2024-07 → now`);
  for (const v of variants) {
    const a = simulatePortfolio(cands, v, START, SPLIT, btcAbove);
    const b = simulatePortfolio(cands, v, SPLIT, Date.now(), btcAbove);
    console.log(`${v.name.padEnd(40)} ${line(a).padEnd(96)} | ${line(b)}`);
  }

  // Grid around the H4/H5 family. Selection: best in-sample Calmar; out-of-sample only reported.
  console.log(`\nGRID (risk per position × slots × risk cap per bar), ranked by IN-SAMPLE Calmar`);
  const grid: { v: Variant; a: Result }[] = [];
  for (const r of [0.0025, 0.005, 0.0075, 0.01])
    for (const slots of [15, 30, 45, 60])
      for (const cap of [0.03, 0.05, 0.08, 0.12, 1]) {
        if (r * slots > 0.15 + 1e-9 && cap === 1) continue; // > 100% invested at the stop distance
        const v: Variant = { ...base, name: `${(r * 100).toFixed(2)}% × ${slots} · bar ≤ ${cap === 1 ? "∞" : `${cap * 100}%`}`, risk: () => r, maxOpen: slots, maxBarRisk: cap };
        grid.push({ v, a: simulatePortfolio(cands, v, START, SPLIT, btcAbove) });
      }
  grid.sort((x, y) => y.a.calmar - x.a.calmar);
  for (const { v, a } of grid.slice(0, 12)) console.log(`${v.name.padEnd(40)} ${line(a).padEnd(96)} | ${line(simulatePortfolio(cands, v, SPLIT, Date.now(), btcAbove))}`);

  const pick = grid[0].v;
  console.log(`\nPER YEAR — ${base.name} vs ${pick.name}`);
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    console.log(`${y}  base ${line(simulatePortfolio(cands, base, from, to, btcAbove))}\n      pick ${line(simulatePortfolio(cands, pick, from, to, btcAbove))}`);
  }
}

if (process.argv[1]?.endsWith("variants.ts")) void main();
