/**
 * Take-profit methods for the bot's setups, on its current entries:
 * v1.2 (first dot only, breadth ≥ 10 counted on all v1 signals) and Setup A (volume,
 * RS < −10%; also all breakouts for reference).
 *
 *   Setup A  chandelier multiple (5–12×ATR) · wider when the entry's volume surged ·
 *            wider after a strong up-bar on a volume spike · exit on a volume climax ·
 *            tighter once well in profit · Turtle exit (close under the 10-day low)
 *   v1.2     at the first red dot: exit (today), or trail the 10-bar low / 3×ATR ·
 *            only after a deep capitulation (breadth) · only on a volume spike ·
 *            exit on a volume climax
 *
 * Same stops as today (v1 −15%; A 8×ATR). Chosen on in-sample only; out-of-sample reported.
 *
 *   npx tsx research/tp.ts
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_A, relativeStrength, volumeSurge } from "../lib/setups/setupA";
import { SETUP_V1, liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import { CACHE_DIR, archiveSymbols, loadSeries, segments, type ResearchBar } from "./data";
import { compare, header, pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { arrays, type Arrays } from "./stops";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const SPLIT = Date.UTC(2024, 6, 1);
const COST = SETUP_V1.cost;

export interface Pair {
  symbol: string;
  c: ResearchBar[];
  a: Arrays;
  volRatio: Float64Array; // bar quote volume ÷ its trailing 30-day per-bar average
  low10d: Float64Array; // lowest low of the 60 bars before
  low10: Float64Array; // lowest low of the 10 bars before
}

export function prepare(symbol: string, c: ResearchBar[]): Pair {
  const n = c.length;
  const volRatio = new Float64Array(n).fill(1);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i >= 180) {
      const avg = sum / 180;
      volRatio[i] = avg > 0 ? c[i].quoteVolume / avg : 1;
      sum -= c[i - 180].quoteVolume;
    }
    sum += c[i].quoteVolume;
  }
  const lowest = (len: number) => {
    const out = new Float64Array(n).fill(Number.NaN);
    const dq: number[] = [];
    let head = 0;
    for (let i = 0; i < n; i++) {
      while (head < dq.length && dq[head] < i - len) head++;
      if (i >= len) out[i] = c[dq[head]].low;
      while (dq.length > head && c[dq[dq.length - 1]].low >= c[i].low) dq.pop();
      dq.push(i);
    }
    return out;
  };
  return { symbol, c, a: arrays(c), volRatio, low10d: lowest(60), low10: lowest(10) };
}

/* ───────────────────────────── exit rules ───────────────────────────── */

export interface ExitA {
  name: string;
  k: number; // chandelier multiple
  kIfSurge?: { surge: number; k: number }; // entry volume ≥ surge × average → k
  widenOnSpike?: { vol: number; k: number }; // once a bar in profit closes up on vol × average → k
  climax?: number; // exit at the close of a bar in profit with volume ≥ this × average, closing in its lower half
  lock?: { gain: number; k: number }; // once the best close is +gain → k
  turtle?: boolean; // exit on a close under the 10-day low instead of the chandelier
  /** Once a spike happens while in profit, tighten the chandelier to k: a 1-day gain, a tall up-bar (× ATR), or an up-bar on volume (× average). */
  spike?: { kind: "gain1d" | "range" | "volume"; level: number; k: number };
}

export interface ExitV1 {
  name: string;
  atRed: "exit" | "low10" | "atr3";
  /** Trail instead of exiting only when the capitulation was at least this broad (breadth). */
  minBreadth?: number;
  /** Trail instead of exiting only when the red-dot bar closed up on volume ≥ this × average. */
  onSpike?: number;
  climax?: number;
}

type Reason = "stop" | "exit" | "end";
interface Held {
  closes: number[];
  exitBars: number;
  exit: number;
  open: boolean;
  reason: Reason;
}

const climaxBar = (p: Pair, i: number, mult: number) => {
  const b = p.c[i];
  return p.volRatio[i] >= mult && b.high > b.low && b.close < (b.high + b.low) / 2;
};

function holdA(p: Pair, s: number, x: ExitA): Held {
  const { c, a } = p;
  const entry = c[s].close;
  const stop = entry - SETUP_A.atrMult * a.atr[s];
  const surge = volumeSurge(c, s, H4);
  let k = x.kIfSurge && surge >= x.kIfSurge.surge ? x.kIfSurge.k : x.k;
  const closes = [entry];
  let best = entry;
  for (let i = s + 1; i < c.length; i++) {
    const bar = c[i];
    const done = (px: number, reason: Reason): Held => {
      closes.push(px);
      return { closes, exitBars: i - s, exit: px, open: false, reason };
    };
    if (bar.low <= stop) return done(Math.min(bar.open, stop), "stop");
    const inProfit = bar.close > entry * (1 + 2 * COST);
    const trailHit = x.turtle ? bar.close < p.low10d[i] : bar.close < best - k * a.atr[i - 1];
    if (trailHit) return done(bar.close, "exit");
    if (x.climax && inProfit && climaxBar(p, i, x.climax)) return done(bar.close, "exit");
    closes.push(bar.close);
    best = Math.max(best, bar.close);
    if (x.widenOnSpike && inProfit && bar.close > bar.open && p.volRatio[i] >= x.widenOnSpike.vol) k = Math.max(k, x.widenOnSpike.k);
    if (x.lock && best >= entry * (1 + x.lock.gain)) k = Math.min(k, x.lock.k);
    if (x.spike && inProfit) {
      const up = bar.close > bar.open;
      const hit =
        x.spike.kind === "gain1d"
          ? i >= 6 && bar.close / c[i - 6].close - 1 >= x.spike.level
          : x.spike.kind === "range"
            ? up && bar.high - bar.low >= x.spike.level * a.atr[i - 1]
            : up && p.volRatio[i] >= x.spike.level;
      if (hit) k = Math.min(k, x.spike.k);
    }
  }
  return { closes, exitBars: closes.length - 1, exit: c[c.length - 1].close, open: true, reason: "end" };
}

function holdV1(p: Pair, s: number, x: ExitV1, breadth: number): Held {
  const { c, a } = p;
  const entry = c[s].close;
  const stop = entry * (1 - SETUP_V1.stopPct);
  const closes = [entry];
  let trailing = false;
  let best = entry;
  for (let i = s + 1; i < c.length; i++) {
    const bar = c[i];
    const done = (px: number, reason: Reason): Held => {
      closes.push(px);
      return { closes, exitBars: i - s, exit: px, open: false, reason };
    };
    // The stop first: within a bar the order of high and low is unknown (as the engine).
    if (bar.low <= stop) return done(stop, "stop");
    const inProfit = bar.close > entry * (1 + 2 * COST);
    if (x.climax && inProfit && climaxBar(p, i, x.climax)) return done(bar.close, "exit");
    if (trailing) {
      const hit = x.atRed === "low10" ? bar.close < p.low10[i] : bar.close < best - 3 * a.atr[i - 1];
      if (hit) return done(bar.close, "exit");
    } else if (a.firstRed[i]) {
      const trail =
        x.atRed !== "exit" &&
        (x.minBreadth === undefined || breadth >= x.minBreadth) &&
        (x.onSpike === undefined || (bar.close > bar.open && p.volRatio[i] >= x.onSpike));
      if (!trail) return done(bar.close, "exit");
      trailing = true;
    }
    closes.push(bar.close);
    best = Math.max(best, bar.close);
  }
  return { closes, exitBars: closes.length - 1, exit: c[c.length - 1].close, open: true, reason: "end" };
}

/* ───────────────────────────── trades ───────────────────────────── */

export interface XTrade extends Trade {
  passes: boolean; // A: volume ≥ 1.5× and RS < −10%
  volumeOk: boolean;
  breadth: number;
  reason: Reason;
}

/** Setup A with an exit rule; every breakout occupies the pair (filtered or not), as the engine. */
export function tradesA(p: Pair, x: ExitA, btc: ResearchBar[]): XTrade[] {
  const { c, a } = p;
  const out: XTrade[] = [];
  for (let s = SETUP_A.warmup; s < c.length; s++) {
    if (!(c[s].close > a.hh[s] && c[s - 1].close <= a.hh[s - 1])) continue;
    const stopDist = (SETUP_A.atrMult * a.atr[s]) / c[s].close;
    if (stopDist > SETUP_A.maxStopPct) continue;
    const h = holdA(p, s, x);
    const rs = relativeStrength(c, s, btc);
    const volumeOk = volumeSurge(c, s, H4) >= SETUP_A.minSurge;
    out.push({
      symbol: p.symbol, at: c[s].time * 1000 + H4, barMs: H4, entry: c[s].close, stopDist, ...h,
      liquidity: liquidity30d(c, s, H4), surge: 1, flow: 0, rs: rs ?? 0, btcUp: null, fng: null,
      volumeOk, passes: volumeOk && rs !== null && rs < SETUP_A.maxRs, breadth: 0,
    });
    if (h.open) break;
    s += h.exitBars;
  }
  return out;
}

/** v1.2 entries (first green dot) with an exit rule. */
export function tradesV1(p: Pair, x: ExitV1, breadthAt: Map<number, number>): XTrade[] {
  const { c, a } = p;
  const out: XTrade[] = [];
  for (let s = SETUP_V1.warmup; s < c.length; s++) {
    let dot = false;
    for (let j = s; j >= s - SETUP_V1.dotWindow; j--) if (a.green[j]) dot = true;
    if (!dot || !a.trigger[s]) continue;
    let earlier = false;
    for (let j = s - SETUP_V1.dotWindow - 1; j >= Math.max(0, s - SETUP_V1.priorDotBars); j--) if (a.green[j]) earlier = true;
    if (earlier) continue;
    const at = c[s].time * 1000 + H4;
    const breadth = breadthAt.get(at) ?? 0;
    const h = holdV1(p, s, x, breadth);
    out.push({
      symbol: p.symbol, at, barMs: H4, entry: c[s].close, stopDist: SETUP_V1.stopPct, ...h,
      liquidity: liquidity30d(c, s, H4), surge: 1, flow: 0, rs: 0, btcUp: null, fng: null,
      volumeOk: true, passes: true, breadth,
    });
    if (h.open) break;
    s += h.exitBars;
  }
  return out;
}

/* ───────────────────────────── report ───────────────────────────── */

const net = (t: Trade) => t.exit / t.entry - 1 - COST - (t.liquidity < 5e6 ? 0.002 : 0);

function perTrade(trades: XTrade[]) {
  const cell = (xs: XTrade[]) => {
    const r = xs.filter((t) => !t.open).map(net);
    if (!r.length) return "–";
    const wins = r.filter((x) => x > 0);
    const losses = r.filter((x) => x <= 0);
    const hold = xs.filter((t) => !t.open).reduce((s, t) => s + (t.exitBars * 4) / 24, 0) / r.length;
    return `avg ${pct(r.reduce((a, b) => a + b, 0) / r.length, 2).padStart(7)} · win ${((100 * wins.length) / r.length).toFixed(0)}% · avg win ${pct(wins.reduce((a, b) => a + b, 0) / Math.max(1, wins.length), 1)} / loss ${pct(losses.reduce((a, b) => a + b, 0) / Math.max(1, losses.length), 1)} · ${hold.toFixed(1)}d`;
  };
  return `${cell(trades.filter((t) => t.at < SPLIT))} │ ${cell(trades.filter((t) => t.at >= SPLIT))}`;
}

async function main() {
  const btc = await loadSeries("BTCUSDT", "4h", 2021);
  const pairs: Pair[] = [];
  const signals: number[] = [];
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")), 3 * DAY)) {
      if (c.length < SETUP_V1.warmup + 30) continue;
      pairs.push(prepare(symbol, c));
      const base = runSetupV1(c, { stoch: "either", intervalMs: H4 });
      for (const t of [...base.trades, ...(base.open ? [base.open] : [])]) signals.push(t.entryTime + H4);
    }
  }
  const breadthAt = new Map<number, number>();
  for (const at of signals) breadthAt.set(at, (breadthAt.get(at) ?? 0) + 1);

  /* Setup A */
  const exitsA: ExitA[] = [
    { name: "today: chandelier 8×ATR", k: 8 },
    { name: "chandelier 5×ATR", k: 5 },
    { name: "chandelier 6×ATR", k: 6 },
    { name: "chandelier 10×ATR", k: 10 },
    { name: "chandelier 12×ATR", k: 12 },
    { name: "12×ATR if entry volume ≥ 3×", k: 8, kIfSurge: { surge: 3, k: 12 } },
    { name: "12×ATR if entry volume ≥ 5×", k: 8, kIfSurge: { surge: 5, k: 12 } },
    { name: "6×ATR, 10× if entry volume ≥ 3×", k: 6, kIfSurge: { surge: 3, k: 10 } },
    { name: "12×ATR after an up-bar on volume ≥ 5×", k: 8, widenOnSpike: { vol: 5, k: 12 } },
    { name: "12×ATR after an up-bar on volume ≥ 10×", k: 8, widenOnSpike: { vol: 10, k: 12 } },
    { name: "exit on volume climax ≥ 5×", k: 8, climax: 5 },
    { name: "exit on volume climax ≥ 10×", k: 8, climax: 10 },
    { name: "tighten to 5×ATR after +50%", k: 8, lock: { gain: 0.5, k: 5 } },
    { name: "tighten to 5×ATR after +100%", k: 8, lock: { gain: 1, k: 5 } },
    { name: "Turtle: close under the 10-day low", k: 8, turtle: true },
  ];
  const aSleeve = (trades: XTrade[], rsOnly: boolean): Sleeve => ({
    trades, accept: (t) => (rsOnly ? (t as XTrade).passes : (t as XTrade).volumeOk), risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025,
  });
  const runA = (rsOnly: boolean) => {
    const rows: { name: string; sleeve: Sleeve; is: Result; trades: XTrade[] }[] = [];
    header(`Setup A (${rsOnly ? "volume + RS < −10%: the bot" : "volume, all RS: reference"}) · take-profit methods`);
    for (const x of exitsA) {
      const trades = pairs.flatMap((p) => tradesA(p, x, btc));
      const sleeve = aSleeve(trades, rsOnly);
      rows.push({ name: x.name, sleeve, trades, is: compare(x.name, [sleeve], x === exitsA[0] ? "= " : "  ") });
    }
    const pick = [...rows].sort((p, q) => q.is.calmar - p.is.calmar)[0];
    console.log(`  ★ in-sample pick: ${pick.name}`);
    console.log("  per trade (accepted entries, IS │ OOS):");
    for (const r of rows) console.log(`    ${r.name.padEnd(40)} ${perTrade(r.trades.filter((t) => (rsOnly ? t.passes : t.volumeOk) && t.liquidity >= 1e6))}`);
    return { rows, pick };
  };
  const aBot = runA(true);
  runA(false);

  /* v1.2 */
  const exitsV1: ExitV1[] = [
    { name: "today: exit at the first red dot", atRed: "exit" },
    { name: "first red dot → trail the 10-bar low", atRed: "low10" },
    { name: "first red dot → trail 3×ATR", atRed: "atr3" },
    { name: "trail 10-bar low if breadth ≥ 25", atRed: "low10", minBreadth: 25 },
    { name: "trail 10-bar low if breadth ≥ 40", atRed: "low10", minBreadth: 40 },
    { name: "trail 10-bar low if red bar on volume ≥ 3×", atRed: "low10", onSpike: 3 },
    { name: "exit on volume climax ≥ 5×", atRed: "exit", climax: 5 },
    { name: "exit on volume climax ≥ 10×", atRed: "exit", climax: 10 },
  ];
  const v1Rows: { name: string; sleeve: Sleeve; is: Result; trades: XTrade[] }[] = [];
  header("v1.2 (first dot, breadth ≥ 10) · take-profit methods");
  for (const x of exitsV1) {
    const trades = pairs.flatMap((p) => tradesV1(p, x, breadthAt));
    const sleeve: Sleeve = { trades, accept: (t) => (t as XTrade).breadth >= 10, risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 };
    v1Rows.push({ name: x.name, sleeve, trades, is: compare(x.name, [sleeve], x === exitsV1[0] ? "= " : "  ") });
  }
  const v1Pick = [...v1Rows].sort((p, q) => q.is.calmar - p.is.calmar)[0];
  console.log(`  ★ in-sample pick: ${v1Pick.name}`);
  console.log("  per trade (breadth ≥ 10, IS │ OOS):");
  for (const r of v1Rows) console.log(`    ${r.name.padEnd(44)} ${perTrade(r.trades.filter((t) => t.breadth >= 10 && t.liquidity >= 1e6))}`);

  header("COMBINED (shared capital): today vs the in-sample picks");
  const todayV1 = v1Rows[0].sleeve;
  const todayA = aBot.rows[0].sleeve;
  compare("today", [todayV1, todayA], "= ");
  compare(`v1: ${v1Pick.name} + A today`, [v1Pick.sleeve, todayA]);
  compare(`v1 today + A: ${aBot.pick.name}`, [todayV1, aBot.pick.sleeve]);
  compare("both picks", [v1Pick.sleeve, aBot.pick.sleeve]);
  console.log(`\nPER YEAR: today │ both picks`);
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    const f = (s: Sleeve[]) => {
      const r = simulate(s, from, to);
      return `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)}`;
    };
    console.log(`  ${y}  ${f([todayV1, todayA])} │ ${f([v1Pick.sleeve, aBot.pick.sleeve])}`);
  }
}

if (process.argv[1]?.endsWith("tp.ts")) void main();
