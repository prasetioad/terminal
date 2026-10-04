/**
 * Funding carry: long spot + short perpetual of the same coin, same notional, while the
 * perpetual's funding is high. Direction-neutral: the position earns the funding the
 * longs pay, and loses only on basis moves and costs. It pays most when the market is
 * greedy — when Setup v1.2 is idle — and steps aside when funding turns negative (crashes).
 *
 *   entry  funding (last payment) ≥ threshold and its 3-day mean ≥ ⅔ of it, spot ≥ $5M/day
 *   exit   3-day mean funding below 0.005% per payment, or a negative payment
 *   P&L    spot return − perp return (both from closes) + funding received (on the perp's
 *          notional), all on the capital of both legs (1× margin: capital = 2 × notional),
 *          costs: 4 taker legs ≈ 0.3% of notional per round trip
 *
 *   npx tsx research/carry.ts      (needs npx tsx research/futures.ts first)
 */
import fs from "node:fs";
import path from "node:path";
import { liquidity30d } from "../lib/setups/setupV1";
import { CACHE_DIR, archiveSymbols, type ResearchBar } from "./data";
import { cachedFutures } from "./futures";
import { compare, header, pct, simulate, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
/** Round trip of 4 taker legs on the notional, beyond the simulator's 0.1% (charged on the capital). */
const EXTRA_COST = 0.003 / 2 - 0.001;

export interface CarryOptions {
  entry: number; // funding per payment, e.g. 0.0003 (0.03%)
  exit: number; // 3-day mean below this → exit
}

export function carryTrades(o: CarryOptions): Trade[] {
  const out: Trade[] = [];
  for (const symbol of SYMBOLS) {
    const fut = cachedFutures(symbol);
    if (!fut || !fut.funding.length || !fut.klines.t.length) continue;
    const spotFile = path.join(CACHE_DIR, "klines", "4h", `${symbol}.json`);
    if (!fs.existsSync(spotFile)) continue;
    const spot: ResearchBar[] = JSON.parse(fs.readFileSync(spotFile, "utf8"));
    const spotIdx = new Map(spot.map((b, i) => [b.time as number, i]));
    const ft = fut.funding.map((f) => f.t);
    let fi = 0; // funding payments up to the current bar close
    let pos: { at: number; s0: number; p0: number; cum: number; closes: number[]; liq: number; bars: number } | null = null;
    for (let k = 0; k < fut.klines.t.length; k++) {
      const t = fut.klines.t[k];
      const si = spotIdx.get(t);
      const close = t * 1000 + H4;
      const prevFi = fi;
      while (fi < ft.length && ft[fi] <= close) fi++;
      if (si === undefined || fi === 0) {
        pos = null; // a gap in either market: no position across it
        continue;
      }
      const last = fut.funding[fi - 1].r;
      let sum = 0;
      let n = 0;
      for (let j = fi - 1; j >= 0 && ft[j] > close - 3 * DAY; j--) {
        sum += fut.funding[j].r;
        n++;
      }
      const mean3d = n ? sum / n : 0;
      const S = spot[si].close;
      const P = fut.klines.close[k];
      if (pos) {
        for (let j = prevFi; j < fi; j++) pos.cum += fut.funding[j].r * (P / pos.p0);
        const value = 1 + 0.5 * (S / pos.s0 - P / pos.p0 + pos.cum) - EXTRA_COST;
        pos.closes.push(value);
        pos.bars++;
        if (mean3d < o.exit || last < 0) {
          out.push({ symbol: `${symbol}#carry`, at: pos.at, barMs: H4, entry: 1, stopDist: 1, closes: pos.closes, exitBars: pos.bars, exit: value, open: false, liquidity: pos.liq, surge: 1, flow: 0, rs: 0, btcUp: null, fng: null });
          pos = null;
        }
        continue;
      }
      if (si < 180 || last < o.entry || mean3d < (2 / 3) * o.entry) continue;
      const liq = liquidity30d(spot, si, H4);
      if (liq < 5e6) continue;
      pos = { at: close, s0: S, p0: P, cum: 0, closes: [1], liq, bars: 0 };
    }
    if (pos && pos.bars > 0)
      out.push({ symbol: `${symbol}#carry`, at: pos.at, barMs: H4, entry: 1, stopDist: 1, closes: pos.closes, exitBars: pos.bars, exit: pos.closes[pos.closes.length - 1], open: true, liquidity: pos.liq, surge: 1, flow: 0, rs: 0, btcUp: null, fng: null });
  }
  return out;
}

let SYMBOLS: string[] = [];
export async function loadCarryUniverse(): Promise<void> {
  SYMBOLS = (await archiveSymbols()).filter(inUniverse);
}

/** A carry sleeve: `alloc` of equity per position, at most `maxOpen`, at most `cap` of equity in total. */
export const carrySleeve = (trades: Trade[], alloc: number, maxOpen: number, cap: number): Sleeve => ({
  trades, risk: alloc, maxFrac: alloc, maxOpen, maxBarRisk: 1, maxExposure: cap,
});

async function main() {
  await loadCarryUniverse();
  header("FUNDING CARRY alone (10% of equity per position, ≤ 5 positions, ≤ 50% in total)");
  const rows: [string, Sleeve][] = [];
  for (const entry of [0.0002, 0.0003, 0.0005, 0.001]) {
    const trades = carryTrades({ entry, exit: 0.00005 });
    const closed = trades.filter((t) => !t.open);
    const r = closed.map((t) => t.exit - 1);
    const name = `entry ≥ ${(entry * 100).toFixed(2)}%/payment`;
    console.log(`  ${name}: ${closed.length} carries · avg ${pct(r.reduce((a, b) => a + b, 0) / r.length, 2)} on capital · win ${((100 * r.filter((x) => x > 0).length) / r.length).toFixed(0)}% · worst ${pct(Math.min(...r), 1)} · avg ${(closed.reduce((s, t) => s + t.exitBars, 0) / closed.length / 6).toFixed(1)} days`);
    const s = carrySleeve(trades, 0.1, 5, 0.5);
    rows.push([name, s]);
    compare(name, [s]);
  }
  console.log("\nPER YEAR (CAGR / DD): " + rows.map(([n]) => n).join(" │ "));
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    console.log(`  ${y}  ` + rows.map(([, s]) => { const x = simulate([s], from, to); return `${pct(x.cagr).padStart(7)} ${pct(x.maxDD).padStart(6)} (${String(x.trades).padStart(3)})`; }).join(" │ "));
  }
}

if (process.argv[1]?.endsWith("carry.ts")) void main();
