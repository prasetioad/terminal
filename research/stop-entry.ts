/**
 * Support trades with the entry moved to where the classic trade puts its stop (owner's idea):
 * if price so often sweeps the stops under a support before turning (§4.22: 60% of trades
 * touched the swing low first), buy the sweep instead of the support. Long only, limit orders.
 * Rules fixed before looking at results:
 *
 *   support / resistance   the lowest low / highest high of the N bars before; an event is a bar
 *                          whose low goes under the support, the support untouched for N/2 bars
 *                          (a fresh level, not a slide through successive lows)
 *   A  classic             buy at the support; stop 0.5 × ATR14 under it (the invalidation);
 *                          target the resistance
 *   B1 entry at the stop   buy at support − 0.5 × ATR (A's stop); stop 1 × ATR under the entry;
 *                          target the resistance
 *   B2                     as B1, target 2R
 *
 *   fills  a limit buy fills at the level, or at the open when the bar gaps under it; a stop and
 *          a target in the same bar count as the stop, and so does a stop touched in the entry
 *          bar; out after N bars at the close
 *   timeframes  1h (N 48 = 2 days), 4h (N 60 = 10 days), 1D (N 30), the whole universe at
 *          ≥ $2M/day; one position per pair and rule at a time
 *
 * Per R (R = entry − stop) and gross % per trade; net at 0.2% (spot) and 0.07% (futures, maker
 * in, taker out). Per event = trades entered in the same bar count as one. IS 2021 → 2024-06,
 * OOS after.
 *
 *   npx tsx research/stop-entry.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { atr14, prefix, stats, type Sample } from "./intraday-edge";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const SPLIT = Date.UTC(2024, 6, 1);
const TFS = [
  { tf: "1h", sec: 3600, n: 48 },
  { tf: "4h", sec: 14_400, n: 60 },
  { tf: "1d", sec: 86_400, n: 30 },
];

interface Trade extends Sample {
  r: number; // gross in R
  risk: number; // entry − stop, share of the entry
  reason: "stop" | "target" | "time";
}
const book = new Map<string, Trade[]>();

function scan(tf: string, n: number, c: ResearchBar[], barSec: number) {
  const len = c.length;
  const a = atr14(c);
  const qv = prefix(c.map((b) => b.quoteVolume));
  const perDay = 86_400 / barSec;
  const busy = new Map<string, number>();
  let lastEvent = -Infinity;
  for (let i = Math.max(n, Math.round(30 * perDay)); i < len - 1; i++) {
    let sup = Infinity;
    let res = -Infinity;
    for (let k = i - n; k < i; k++) {
      sup = Math.min(sup, c[k].low);
      res = Math.max(res, c[k].high);
    }
    if (!(c[i].low < sup)) continue;
    const fresh = i - lastEvent > n / 2;
    lastEvent = i;
    if (!fresh || Number.isNaN(a[i - 1])) continue;
    if (((qv[i] - qv[i - Math.round(30 * perDay)]) / 30) < 2e6) continue;
    const atr = a[i - 1];
    const rules = [
      { name: "A classic: buy the support", entry: sup, stop: sup - 0.5 * atr, target: () => res },
      { name: "B1 buy at A's stop → resistance", entry: sup - 0.5 * atr, stop: sup - 1.5 * atr, target: () => res },
      { name: "B2 buy at A's stop → 2R", entry: sup - 0.5 * atr, stop: sup - 1.5 * atr, target: (e: number) => e + 2 * (e - (sup - 1.5 * atr)) },
    ];
    for (const r of rules) {
      const key = `${tf} · ${r.name}`;
      if ((busy.get(key) ?? -1) >= i) continue;
      // the limit order waits from bar i on: the event bar or a later one within N bars
      let e = -1;
      let fill = 0;
      for (let x = i; x < Math.min(len, i + n); x++) {
        if (c[x].low <= r.entry) {
          e = x;
          fill = Math.min(c[x].open, r.entry);
          break;
        }
        // the trade idea is gone once price is back above the resistance
        if (c[x].high >= res) break;
      }
      if (e < 0) continue;
      const target = r.target(fill);
      const risk = (fill - r.stop) / fill;
      if (risk <= 0) continue;
      let px = Number.NaN;
      let reason: Trade["reason"] = "time";
      let x = e;
      const last = Math.min(len - 1, e + n);
      if (c[e].low <= r.stop) {
        px = r.stop;
        reason = "stop";
      } else {
        for (x = e + 1; x <= last; x++) {
          if (c[x].low <= r.stop) {
            px = Math.min(c[x].open, r.stop);
            reason = "stop";
            break;
          }
          if (c[x].high >= target) {
            px = Math.max(c[x].open, target);
            reason = "target";
            break;
          }
        }
        if (Number.isNaN(px)) {
          x = last;
          px = c[last].close;
        }
      }
      busy.set(key, x);
      const gross = px / fill - 1;
      const list = book.get(key) ?? [];
      list.push({ at: (c[e].time + barSec) * 1000, gross, r: gross / risk, risk, reason });
      book.set(key, list);
    }
  }
}

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  for (const { tf, sec, n } of TFS) {
    for (const symbol of symbols) {
      const file = path.join(CACHE_DIR, "klines", tf, `${symbol}.json`);
      if (!fs.existsSync(file)) continue;
      for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")), Math.max(3 * 86_400_000, 6 * sec * 1000))) if (c.length > 400) scan(tf, n, c, sec);
    }
  }
  console.log("Support trades, long, limit entries · IS 2021 → 2024-06 │ OOS after\n");
  console.log("n · win · gross/trade (t per event) · per R gross · net per R at 0.2% (spot) │ 0.07% (futures) · stop/target/time · risk median");
  const row = (xs: Trade[]) => {
    const s = stats(xs);
    if (!s) return "–";
    const m = (f: (t: Trade) => number) => xs.reduce((a, t) => a + f(t), 0) / xs.length;
    const share = (r: Trade["reason"]) => `${((100 * xs.filter((t) => t.reason === r).length) / xs.length).toFixed(0)}%`;
    const risks = xs.map((t) => t.risk).sort((p, q) => p - q);
    return `n ${String(s.n).padStart(6)} · win ${(100 * xs.filter((t) => t.gross > 0).length / xs.length).toFixed(0)}% · ${pct(s.g, 2).padStart(7)} (t ${s.eventT.toFixed(1).padStart(5)}) · ${m((t) => t.r).toFixed(3).padStart(6)}R · ${m((t) => (t.gross - 0.002) / t.risk).toFixed(3).padStart(6)}R │ ${m((t) => (t.gross - 0.0007) / t.risk).toFixed(3).padStart(6)}R · ${share("stop")}/${share("target")}/${share("time")} · risk ${pct(risks[Math.floor(risks.length / 2)], 2)}`;
  };
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    console.log(`  ${key}`);
    console.log(`    IS  ${row(xs.filter((t) => t.at < SPLIT))}`);
    console.log(`    OOS ${row(xs.filter((t) => t.at >= SPLIT))}`);
  }
  console.log("\nPER YEAR, net per R at 0.2% (n)");
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    const years: string[] = [];
    for (let y = 2021; y <= 2026; y++) {
      const ys = xs.filter((t) => new Date(t.at).getUTCFullYear() === y);
      if (ys.length) years.push(`${y} ${(ys.reduce((a, t) => a + (t.gross - 0.002) / t.risk, 0) / ys.length).toFixed(2)}R (${ys.length})`);
    }
    console.log(`  ${key.padEnd(40)} ${years.join(" · ")}`);
  }
}

if (process.argv[1]?.endsWith("stop-entry.ts")) void main();
