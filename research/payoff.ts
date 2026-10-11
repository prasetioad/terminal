/**
 * Risk/reward of the bot's setups as traded (4h, the bot's engines and filters, cost 0.2%):
 * win rate, average win and loss, payoff (avg win ÷ avg loss), expectancy per trade in % and in
 * R (R = the distance to the initial stop), the share of the total profit from the best 10% of
 * trades, and the longest losing streak. IS 2021 → 2024-06 and OOS after, accepted entries only
 * (v1.2: first dot, breadth ≥ 10; Setup A: volume ≥ 1.5×, RS < −10%; ≥ $1M/day).
 *
 *   npx tsx research/payoff.ts
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_A, runSetupA } from "../lib/setups/setupA";
import { SETUP_V1, liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const SPLIT = Date.UTC(2024, 6, 1);
const COST = 0.002;

interface T {
  at: number;
  ret: number;
  risk: number;
}

function report(name: string, xs: T[]) {
  const wins = xs.filter((t) => t.ret > 0);
  const losses = xs.filter((t) => t.ret <= 0);
  const avg = (v: T[], f: (t: T) => number) => v.reduce((a, t) => a + f(t), 0) / Math.max(1, v.length);
  const avgWin = avg(wins, (t) => t.ret);
  const avgLoss = -avg(losses, (t) => t.ret);
  const sorted = [...xs].sort((a, b) => b.ret - a.ret);
  const total = xs.reduce((a, t) => a + t.ret, 0);
  const top = sorted.slice(0, Math.ceil(xs.length * 0.1)).reduce((a, t) => a + t.ret, 0);
  let streak = 0;
  let worst = 0;
  for (const t of [...xs].sort((a, b) => a.at - b.at)) {
    streak = t.ret <= 0 ? streak + 1 : 0;
    worst = Math.max(worst, streak);
  }
  const winR = avg(wins, (t) => t.ret / t.risk);
  const lossR = -avg(losses, (t) => t.ret / t.risk);
  console.log(
    `  ${name.padEnd(5)} n ${String(xs.length).padStart(4)} · win ${(100 * wins.length / xs.length).toFixed(0)}% · avg win ${pct(avgWin, 1)} (${winR.toFixed(2)}R) · avg loss −${(100 * avgLoss).toFixed(1)}% (${lossR.toFixed(2)}R) · payoff ${(avgWin / avgLoss).toFixed(2)} · expectancy ${pct(avg(xs, (t) => t.ret), 2)} = ${avg(xs, (t) => t.ret / t.risk).toFixed(2)}R · best 10% = ${((100 * top) / total).toFixed(0)}% of profit · longest losing run ${worst}`,
  );
}

async function main() {
  const btcFile = path.join(CACHE_DIR, "klines", "4h", "BTCUSDT.json");
  const btc: Candle[] = JSON.parse(fs.readFileSync(btcFile, "utf8"));
  const v1: (T & { breadthKey: number })[] = [];
  const signals = new Map<number, number>();
  const a: T[] = [];
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")) as ResearchBar[], 3 * 86_400_000)) {
      if (c.length < SETUP_V1.warmup + 30) continue;
      const candles = c as unknown as Candle[];
      const base = runSetupV1(candles, { stoch: "either", intervalMs: H4 });
      for (const t of [...base.trades, ...(base.open ? [base.open] : [])]) signals.set(t.entryTime, (signals.get(t.entryTime) ?? 0) + 1);
      for (const t of runSetupV1(candles, { stoch: "either", intervalMs: H4, firstDotOnly: true }).trades) {
        if (liquidity30d(candles, t.entryIndex, H4) < 1e6 || t.exitPrice === null) continue;
        v1.push({ at: t.entryTime, ret: t.exitPrice / t.entryPrice - 1 - COST, risk: SETUP_V1.stopPct, breadthKey: t.entryTime });
      }
      for (const t of runSetupA(candles, H4, { btc, maxRs: SETUP_A.maxRs, spikeTighten: SETUP_A.spikeTighten }).trades) {
        if (!t.passes || liquidity30d(candles, t.entryIndex, H4) < 1e6 || t.exitPrice === null) continue;
        a.push({ at: t.entryTime, ret: t.exitPrice / t.entryPrice - 1 - COST, risk: 1 - t.stopPrice / t.entryPrice });
      }
    }
  }
  const v1ok = v1.filter((t) => (signals.get(t.breadthKey) ?? 0) >= SETUP_V1.minBreadth);
  console.log("Closed trades, cost 0.2% · IS 2021 → 2024-06 │ OOS after\n");
  for (const [label, f] of [["IS", (t: T) => t.at < SPLIT], ["OOS", (t: T) => t.at >= SPLIT]] as const) {
    console.log(label);
    report("v1.2", v1ok.filter(f));
    report("A", a.filter(f));
  }
}

if (process.argv[1]?.endsWith("payoff.ts")) void main();
