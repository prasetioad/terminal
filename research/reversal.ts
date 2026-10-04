/**
 * Do stopped-out trades show a profit first, and can a reversal sign take that profit
 * before the stop? For Setup v1.2 (breadth ≥ 10) and Setup A (volume-confirmed).
 *
 * 1. Profile of stopped trades: how far they rose (MFE), when the peak came, how long
 *    from the peak to the stop; and how much winners give back before their exit.
 * 2. Early exits tested on the same entries (per trade) and in bot-like portfolios:
 *    stoch cross down from above 80 · any bearish WaveTrend cross · close back to the
 *    entry after +X% · close below half of the gain after +X% · half the position
 *    taken off at +X%. Chosen on in-sample only; out-of-sample reported.
 *
 *   npx tsx research/reversal.ts
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_A, volumeSurge } from "../lib/setups/setupA";
import { SETUP_V1, liquidity30d } from "../lib/setups/setupV1";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { compare, header, pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { arrays, type Arrays } from "./stops";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const SPLIT = Date.UTC(2024, 6, 1);
const COST = SETUP_V1.cost;

type Early =
  | { kind: "none" }
  | { kind: "stochDown" } // stoch crosses down from above 80
  | { kind: "wtDown" } // any bearish WaveTrend cross
  | { kind: "backToEntry"; arm: number } // after +arm, a close back at the entry
  | { kind: "halfGain"; arm: number } // after +arm, a close below half of the best gain
  | { kind: "afterGain"; arm: number; sign: "stochDown" | "wtDown" }; // a reversal sign, only once +arm was reached

const earlyName = (e: Early): string =>
  e.kind === "none" ? "none" : e.kind === "backToEntry" || e.kind === "halfGain" ? `${e.kind} after +${e.arm * 100}%` : e.kind === "afterGain" ? `${e.sign} after +${e.arm * 100}%` : e.kind;

interface Held {
  closes: number[];
  exitBars: number;
  exit: number;
  open: boolean;
  reason: "stop" | "main" | "early" | "tp" | "end";
  mfe: number;
  peakBar: number; // bars from entry to the best high
}

/**
 * Hold from bar s: the resting stop first (filled at the stop or the open on a gap), an
 * optional take-profit limit, then the setup's own exit (v1: first red dot; A: 8×ATR
 * chandelier), then the early exit at the close.
 */
function hold(c: ResearchBar[], a: Arrays, s: number, stopDist: number, main: "red" | "chandelier", early: Early, tp = 0): Held {
  const entry = c[s].close;
  const stop = entry * (1 - stopDist);
  const closes = [entry];
  let best = entry;
  let high = entry;
  let peakBar = 0;
  let mfe = 0;
  for (let i = s + 1; i < c.length; i++) {
    const bar = c[i];
    const done = (exit: number, reason: Held["reason"]): Held => {
      closes.push(exit);
      return { closes, exitBars: i - s, exit, open: false, reason, mfe, peakBar };
    };
    if (bar.low <= stop) return done(Math.min(bar.open, stop), "stop");
    if (bar.high > high) {
      high = bar.high;
      peakBar = i - s;
    }
    mfe = high / entry - 1;
    if (tp > 0 && bar.high >= entry * (1 + tp)) return done(Math.max(bar.open, entry * (1 + tp)), "tp");
    const mainExit = main === "red" ? a.firstRed[i] === 1 : bar.close < best - SETUP_A.atrMult * a.atr[i - 1];
    if (mainExit) return done(bar.close, "main");
    let earlyExit = false;
    if (early.kind === "stochDown") earlyExit = a.stochDown[i] === 1;
    else if (early.kind === "wtDown") earlyExit = a.wtDown[i] === 1;
    else if (early.kind === "backToEntry") earlyExit = mfe >= early.arm && bar.close <= entry * (1 + 2 * COST);
    else if (early.kind === "halfGain") earlyExit = mfe >= early.arm && bar.close < entry + 0.5 * (high - entry);
    else if (early.kind === "afterGain") earlyExit = mfe >= early.arm && (early.sign === "stochDown" ? a.stochDown[i] === 1 : a.wtDown[i] === 1);
    if (earlyExit) return done(bar.close, "early");
    closes.push(bar.close);
    best = Math.max(best, bar.close);
  }
  return { closes, exitBars: closes.length - 1, exit: c[c.length - 1].close, open: true, reason: "end", mfe, peakBar };
}

interface Pair {
  symbol: string;
  c: ResearchBar[];
  a: Arrays;
}

interface XTrade extends Trade {
  setup: "v1" | "a";
  s: number; // entry bar
  pair: Pair;
  reason: Held["reason"];
  mfe: number;
  peakBar: number;
  breadth: number;
  passes: boolean;
}

const isV1Entry = (p: Pair, s: number) => {
  if (!p.a.trigger[s]) return false;
  for (let j = s; j >= s - SETUP_V1.dotWindow; j--) if (p.a.green[j]) return true;
  return false;
};
const isAEntry = (p: Pair, s: number) =>
  p.c[s].close > p.a.hh[s] && p.c[s - 1].close <= p.a.hh[s - 1] && (SETUP_A.atrMult * p.a.atr[s]) / p.c[s].close <= SETUP_A.maxStopPct;

/** One position at a time per pair (and leg), as the engines. */
function generate(p: Pair, setup: "v1" | "a", early: Early, tp: number, breadthAt: Map<number, number>, leg = ""): XTrade[] {
  const out: XTrade[] = [];
  const { c, a } = p;
  for (let s = SETUP_V1.warmup; s < c.length; s++) {
    if (!(setup === "v1" ? isV1Entry(p, s) : isAEntry(p, s))) continue;
    const stopDist = setup === "v1" ? SETUP_V1.stopPct : (SETUP_A.atrMult * a.atr[s]) / c[s].close;
    const h = hold(c, a, s, stopDist, setup === "v1" ? "red" : "chandelier", early, tp);
    const at = c[s].time * 1000 + H4;
    out.push({
      symbol: p.symbol + leg, at, barMs: H4, entry: c[s].close, stopDist, closes: h.closes, exitBars: h.exitBars, exit: h.exit, open: h.open,
      liquidity: liquidity30d(c, s, H4), surge: 1, flow: 0, rs: 0, btcUp: null, fng: null,
      setup, s, pair: p, reason: h.reason, mfe: h.mfe, peakBar: h.peakBar, breadth: breadthAt.get(at) ?? 0,
      passes: setup === "a" ? volumeSurge(c, s, H4) >= SETUP_A.minSurge : true,
    });
    if (h.open) break;
    s += h.exitBars;
  }
  return out;
}

const net = (t: { exit: number; entry: number; liquidity: number }) => t.exit / t.entry - 1 - COST - (t.liquidity < 5e6 ? 0.002 : 0);
const quantile = (xs: number[], q: number) => {
  const ys = [...xs].sort((x, y) => x - y);
  return ys.length ? ys[Math.min(ys.length - 1, Math.floor(q * ys.length))] : Number.NaN;
};

function profile(title: string, trades: XTrade[]) {
  const stopped = trades.filter((t) => t.reason === "stop");
  const winners = trades.filter((t) => net(t) > 0);
  const p = (x: number) => pct(x, 1);
  console.log(`\n${title}: ${trades.length} trades · ${stopped.length} stopped (${((100 * stopped.length) / trades.length).toFixed(0)}%) · ${winners.length} winners`);
  const mfe = stopped.map((t) => t.mfe);
  console.log(`  stopped trades, best gain before the stop: mean ${p(mfe.reduce((a, b) => a + b, 0) / mfe.length)} · median ${p(quantile(mfe, 0.5))} · 75th ${p(quantile(mfe, 0.75))} · 90th ${p(quantile(mfe, 0.9))}`);
  const share = (f: (t: XTrade) => boolean) => `${((100 * stopped.filter(f).length) / stopped.length).toFixed(0)}%`;
  console.log(`  …reached at least: +1% ${share((t) => t.mfe >= 0.01)} · +2% ${share((t) => t.mfe >= 0.02)} · +3% ${share((t) => t.mfe >= 0.03)} · +5% ${share((t) => t.mfe >= 0.05)} · +8% ${share((t) => t.mfe >= 0.08)} · +10% ${share((t) => t.mfe >= 0.1)}`);
  const peak = stopped.map((t) => (t.peakBar * 4) / 24);
  const fall = stopped.map((t) => ((t.exitBars - t.peakBar) * 4) / 24);
  console.log(`  peak after (median) ${quantile(peak, 0.5).toFixed(1)} days · then stop after ${quantile(fall, 0.5).toFixed(1)} more days (median)`);
  const capture = winners.map((t) => (t.exit / t.entry - 1) / Math.max(1e-9, t.mfe));
  const given = winners.map((t) => t.mfe - (t.exit / t.entry - 1));
  console.log(`  winners: best gain median ${p(quantile(winners.map((t) => t.mfe), 0.5))} · exit keeps ${(100 * quantile(capture, 0.5)).toFixed(0)}% of it (median) · gives back ${p(quantile(given, 0.5))} (median)`);
}

/** Same entries, another exit: what happens to the base's stopped trades and to its winners? */
function perTrade(base: XTrade[], early: Early, tp: number) {
  const main = base[0].setup === "v1" ? "red" : "chandelier";
  const redo = (t: XTrade) => {
    const h = hold(t.pair.c, t.pair.a, t.s, t.stopDist, main, early, tp);
    return net({ exit: h.exit, entry: t.entry, liquidity: t.liquidity });
  };
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const stopped = base.filter((t) => t.reason === "stop");
  const winners = base.filter((t) => net(t) > 0);
  const cell = (xs: XTrade[]) => `${pct(avg(xs.map(net)), 1).padStart(6)} → ${pct(avg(xs.map(redo)), 1).padStart(6)}`;
  return `stopped ${cell(stopped)} · winners ${cell(winners)} · all ${cell(base)}`;
}

async function main() {
  const pairs: Pair[] = [];
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")), 3 * DAY)) if (c.length >= SETUP_V1.warmup + 30) pairs.push({ symbol, c, a: arrays(c) });
  }
  const none: Early = { kind: "none" };
  const breadthAt = new Map<number, number>();
  for (const t of pairs.flatMap((p) => generate(p, "v1", none, 0, new Map()))) breadthAt.set(t.at, (breadthAt.get(t.at) ?? 0) + 1);

  const baseV1 = pairs.flatMap((p) => generate(p, "v1", none, 0, breadthAt)).filter((t) => t.breadth >= 10 && t.liquidity >= 1e6 && !t.open);
  const baseA = pairs.flatMap((p) => generate(p, "a", none, 0, breadthAt)).filter((t) => t.passes && t.liquidity >= 1e6 && !t.open);
  for (const [title, base] of [["v1.2", baseV1], ["Setup A", baseA]] as const) {
    profile(`${title} · all`, base);
    profile(`${title} · in-sample`, base.filter((t) => t.at < SPLIT));
    profile(`${title} · out-of-sample`, base.filter((t) => t.at >= SPLIT));
  }

  const earlies: Early[] = [
    none,
    { kind: "stochDown" },
    { kind: "wtDown" },
    { kind: "backToEntry", arm: 0.03 },
    { kind: "backToEntry", arm: 0.05 },
    { kind: "halfGain", arm: 0.05 },
    { kind: "halfGain", arm: 0.1 },
    { kind: "afterGain", arm: 0.03, sign: "stochDown" },
    { kind: "afterGain", arm: 0.05, sign: "wtDown" },
  ];
  console.log("\nSAME ENTRIES, OTHER EXIT: average net return per trade, today → with the rule (all periods)");
  for (const [title, base] of [["v1.2", baseV1], ["Setup A", baseA]] as const) {
    console.log(`  ${title}`);
    for (const e of earlies.slice(1)) console.log(`    ${earlyName(e).padEnd(28)} ${perTrade(base, e, 0)}`);
    for (const tp of title === "v1.2" ? [0.03, 0.05, 0.08] : [0.1, 0.2, 0.3]) console.log(`    ${`all out at +${tp * 100}%`.padEnd(28)} ${perTrade(base, none, tp)}`);
  }

  // Portfolios. Half-off at +X%: two half-size legs, one with the take-profit.
  const v1Sleeve = (trades: XTrade[], legs = 1): Sleeve => ({ trades, accept: (t) => (t as XTrade).breadth >= 10, risk: 0.01 / legs, maxFrac: 0.1 / legs, maxOpen: 15 * legs, maxBarRisk: 0.05 });
  const aSleeve = (trades: XTrade[], legs = 1): Sleeve => ({ trades, accept: (t) => (t as XTrade).passes, risk: 0.005 / legs, maxFrac: 0.1 / legs, maxOpen: 15 * legs, maxBarRisk: 0.025 });
  for (const setup of ["v1", "a"] as const) {
    const make = setup === "v1" ? v1Sleeve : aSleeve;
    const rows: { name: string; is: Result; sleeve: Sleeve }[] = [];
    header(`${setup === "v1" ? "v1.2" : "Setup A"} · early exits in the portfolio`);
    for (const e of earlies) {
      const sleeve = make(pairs.flatMap((p) => generate(p, setup, e, 0, breadthAt)));
      rows.push({ name: earlyName(e), sleeve, is: compare(earlyName(e), [sleeve], e.kind === "none" ? "= " : "  ") });
    }
    for (const tp of setup === "v1" ? [0.03, 0.05, 0.08] : [0.1, 0.2, 0.3]) {
      const legs = pairs.flatMap((p) => [...generate(p, setup, none, tp, breadthAt, "#tp"), ...generate(p, setup, none, 0, breadthAt)]);
      const name = `half off at +${tp * 100}%`;
      const sleeve = make(legs, 2);
      rows.push({ name, sleeve, is: compare(name, [sleeve]) });
    }
    const pick = [...rows].sort((x, y) => y.is.calmar - x.is.calmar)[0];
    console.log(`  ★ in-sample pick: ${pick.name}`);
    if (pick.name !== "none") {
      console.log(`  per year: today │ ${pick.name}`);
      for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
        const from = Date.UTC(y, 0, 1);
        const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
        const f = (s: Sleeve) => {
          const r = simulate([s], from, to);
          return `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)}`;
        };
        console.log(`    ${y}  ${f(rows[0].sleeve)} │ ${f(pick.sleeve)}`);
      }
    }
  }
}

void main();
