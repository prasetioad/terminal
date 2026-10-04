/**
 * More profit from the setups we have, plus a complement — on the bot's current rules
 * (v1.2 first dot; Setup A volume + RS < −10%, 8×ATR trail tightened to 4×ATR after a
 * ≥ 3×ATR up-bar in profit):
 *
 *   1  Setup A re-entry: within 30 days after a winning exit, buy again when the trend
 *      resumes (a close above the last trade's best close, or any new 20-day breakout
 *      without the RS/volume filters)
 *   2  Setup A pyramiding: one add-on at +1R or +2R (risk to the current trail), exiting
 *      with the base position
 *   3  Tighter spike trail: 2×ATR after an up-bar on volume ≥ 5× (or ≥ 3×ATR range)
 *   4  Funding carry as a third sleeve (research/carry.ts)
 *
 * Chosen on in-sample only; out-of-sample reported.
 *
 *   npx tsx research/maximize.ts
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_A, relativeStrength, volumeSurge } from "../lib/setups/setupA";
import { SETUP_V1, liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import { carrySleeve, carryTrades, loadCarryUniverse } from "./carry";
import { CACHE_DIR, archiveSymbols, loadSeries, segments, type ResearchBar } from "./data";
import { compare, header, pct, simulate, type Result, type Sleeve } from "./momentum";
import { prepare, tradesA, tradesV1, type ExitA, type Pair, type XTrade } from "./tp";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const COST = SETUP_V1.cost;
const SPIKE: ExitA = { name: "bot", k: 8, spike: { kind: "range", level: 3, k: 4 } };

interface Held {
  closes: number[];
  trail: number[]; // effective exit level after each bar (max of stop and chandelier)
  exitBars: number;
  exit: number;
  open: boolean;
  best: number;
}

/** Setup A's exit as the bot runs it (8×ATR stop, chandelier, spike tightening), recording the trail. */
function hold(p: Pair, s: number, spike: ExitA["spike"]): Held {
  const { c, a } = p;
  const entry = c[s].close;
  const stop = entry - SETUP_A.atrMult * a.atr[s];
  let k: number = SETUP_A.atrMult;
  const closes = [entry];
  const trail = [stop];
  let best = entry;
  for (let i = s + 1; i < c.length; i++) {
    const bar = c[i];
    if (bar.low <= stop) {
      closes.push(Math.min(bar.open, stop));
      return { closes, trail, exitBars: i - s, exit: Math.min(bar.open, stop), open: false, best };
    }
    if (bar.close < best - k * a.atr[i - 1]) {
      closes.push(bar.close);
      return { closes, trail, exitBars: i - s, exit: bar.close, open: false, best };
    }
    closes.push(bar.close);
    best = Math.max(best, bar.close);
    if (spike && bar.close > entry * (1 + 2 * COST)) {
      const up = bar.close > bar.open;
      const hit = spike.kind === "volume" ? up && p.volRatio[i] >= spike.level : spike.kind === "range" ? up && bar.high - bar.low >= spike.level * a.atr[i - 1] : i >= 6 && bar.close / c[i - 6].close - 1 >= spike.level;
      if (hit) k = Math.min(k, spike.k);
    }
    trail.push(Math.max(stop, best - k * a.atr[i]));
  }
  return { closes, trail, exitBars: closes.length - 1, exit: c[c.length - 1].close, open: true, best };
}

const isBreakout = (p: Pair, s: number) => p.c[s].close > p.a.hh[s] && p.c[s - 1].close <= p.a.hh[s - 1] && (SETUP_A.atrMult * p.a.atr[s]) / p.c[s].close <= SETUP_A.maxStopPct;

function base(p: Pair, s: number, h: Held, extra: Partial<XTrade> = {}): XTrade {
  const { c, a } = p;
  const rs = relativeStrength(c, s, BTC);
  const volumeOk = volumeSurge(c, s, H4) >= SETUP_A.minSurge;
  return {
    symbol: p.symbol, at: c[s].time * 1000 + H4, barMs: H4, entry: c[s].close, stopDist: (SETUP_A.atrMult * a.atr[s]) / c[s].close,
    closes: h.closes, exitBars: h.exitBars, exit: h.exit, open: h.open,
    liquidity: liquidity30d(c, s, H4), surge: 1, flow: 0, rs: rs ?? 0, btcUp: null, fng: null,
    volumeOk, passes: volumeOk && rs !== null && rs < SETUP_A.maxRs, breadth: 0, reason: "exit", ...extra,
  };
}

type Reentry = "none" | "aboveBest" | "anyBreakout";

/** Setup A with re-entry after a winning exit (passes regardless of the RS/volume filters). */
function withReentry(p: Pair, mode: Reentry, spike: ExitA["spike"]): XTrade[] {
  const { c } = p;
  const out: XTrade[] = [];
  let until = -1;
  let ref = Number.POSITIVE_INFINITY;
  for (let s = SETUP_A.warmup; s < c.length; s++) {
    const reentry = mode !== "none" && s <= until && (mode === "aboveBest" ? c[s].close > ref && c[s - 1].close <= ref && (SETUP_A.atrMult * p.a.atr[s]) / c[s].close <= SETUP_A.maxStopPct : isBreakout(p, s));
    if (!reentry && !isBreakout(p, s)) continue;
    const h = hold(p, s, spike);
    const t = base(p, s, h);
    if (reentry) t.passes = true;
    out.push(t);
    if (h.open) break;
    const won = h.exit / c[s].close - 1 - COST > 0;
    // A re-entry window opens after a winning trade that the setup itself took (or re-took).
    if (won && (t.passes || reentry)) {
      until = s + h.exitBars + 180;
      ref = h.best;
    } else until = -1;
    s += h.exitBars;
  }
  return out;
}

/** One add-on per Setup A trade once it is up `r` × its initial stop distance; it exits with the base. */
function addOns(p: Pair, r: number, spike: ExitA["spike"]): XTrade[] {
  const { c } = p;
  const out: XTrade[] = [];
  for (let s = SETUP_A.warmup; s < c.length; s++) {
    if (!isBreakout(p, s)) continue;
    const h = hold(p, s, spike);
    const b = base(p, s, h);
    const target = c[s].close * (1 + r * b.stopDist);
    for (let j = 1; j < h.exitBars; j++) {
      if (h.closes[j] < target) continue;
      const entry = h.closes[j];
      const risk = (entry - h.trail[j]) / entry;
      if (risk <= 0.01) break;
      out.push({ ...b, symbol: `${p.symbol}#add`, at: c[s + j].time * 1000 + H4, entry, stopDist: risk, closes: h.closes.slice(j), exitBars: h.exitBars - j });
      break;
    }
    if (h.open) break;
    s += h.exitBars;
  }
  return out;
}

let BTC: ResearchBar[] = [];

async function main() {
  BTC = await loadSeries("BTCUSDT", "4h", 2021);
  const pairs: Pair[] = [];
  const signals: number[] = [];
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")), 3 * DAY)) {
      if (c.length < SETUP_V1.warmup + 30) continue;
      pairs.push(prepare(symbol, c));
      const b = runSetupV1(c, { stoch: "either", intervalMs: H4 });
      for (const t of [...b.trades, ...(b.open ? [b.open] : [])]) signals.push(t.entryTime + H4);
    }
  }
  const breadthAt = new Map<number, number>();
  for (const at of signals) breadthAt.set(at, (breadthAt.get(at) ?? 0) + 1);
  const v1: Sleeve = { trades: pairs.flatMap((p) => tradesV1(p, { name: "", atRed: "exit" }, breadthAt)), accept: (t) => (t as XTrade).breadth >= 10, risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 };
  const aSleeve = (trades: XTrade[], risk = 0.005): Sleeve => ({ trades, accept: (t) => (t as XTrade).passes, risk, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 5 * risk });

  // Fidelity: the local hold reproduces tp.ts's spike trail.
  const ref = pairs.flatMap((p) => tradesA(p, SPIKE, BTC));
  const mine = pairs.flatMap((p) => withReentry(p, "none", SPIKE.spike));
  const same = ref.length === mine.length && ref.every((t, i) => t.at === mine[i].at && Math.abs(t.exit - mine[i].exit) < 1e-9 * t.exit && t.passes === mine[i].passes);
  console.log(`fidelity vs research/tp.ts: ${same ? "identical" : "DIFFERENT"} (${mine.length} breakouts)`);

  const today = aSleeve(mine);
  const rows: { name: string; sleeves: Sleeve[]; is: Result }[] = [];
  const run = (name: string, sleeves: Sleeve[], mark = "  ") => rows.push({ name, sleeves, is: compare(name, sleeves, mark) });

  header("1 · SETUP A RE-ENTRY within 30 days after a winning exit (combined with v1.2)");
  run("today", [v1, today], "= ");
  run("re-enter above the last best close", [v1, aSleeve(pairs.flatMap((p) => withReentry(p, "aboveBest", SPIKE.spike)))]);
  run("re-enter on any new breakout", [v1, aSleeve(pairs.flatMap((p) => withReentry(p, "anyBreakout", SPIKE.spike)))]);

  header("2 · SETUP A PYRAMIDING: one add-on, exits with the base (combined with v1.2)");
  for (const r of [1, 2])
    for (const risk of [0.0025, 0.005]) {
      const adds = pairs.flatMap((p) => addOns(p, r, SPIKE.spike));
      run(`add at +${r}R, risk ${risk * 100}% to the trail`, [v1, today, aSleeve(adds, risk)]);
    }

  header("3 · TIGHTER SPIKE TRAIL (combined with v1.2)");
  for (const [name, spike] of [
    ["volume ≥ 5× → 2×ATR", { kind: "volume", level: 5, k: 2 }],
    ["volume ≥ 5× → 3×ATR", { kind: "volume", level: 5, k: 3 }],
    ["range ≥ 3×ATR → 2×ATR", { kind: "range", level: 3, k: 2 }],
    ["+20% in a day → 2×ATR", { kind: "gain1d", level: 0.2, k: 2 }],
  ] as const)
    run(name, [v1, aSleeve(pairs.flatMap((p) => withReentry(p, "none", spike)))]);

  header("4 · FUNDING CARRY as a third sleeve (10% per carry, ≤ 5, ≤ 50% of equity)");
  await loadCarryUniverse();
  for (const entry of [0.0003, 0.0005]) run(`+ carry, entry ≥ ${(entry * 100).toFixed(2)}%`, [v1, today, carrySleeve(carryTrades({ entry, exit: 0.00005 }), 0.1, 5, 0.5)]);

  const best = [...rows].sort((x, y) => y.is.calmar - x.is.calmar)[0];
  console.log(`\n★ in-sample pick: ${best.name}`);
  console.log(`PER YEAR: today │ ${best.name}`);
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    const f = (s: Sleeve[]) => {
      const r = simulate(s, from, to);
      return `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)}`;
    };
    console.log(`  ${y}  ${f(rows[0].sleeves)} │ ${f(best.sleeves)}`);
  }
}

void main();
