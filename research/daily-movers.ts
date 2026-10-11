/**
 * Can we pick, at a day's close, the coins that rise 5–15% the next day (owner's question)?
 * Daily candles, the whole survivorship-free universe at ≥ $2M/day, 2021 → now. Screens fixed
 * before looking at results; each scored on the next day (close → close):
 *
 *   base rate      every liquid coin-day
 *   breakout+vol   close at a new 20-day high on volume ≥ 3× its 30-day average
 *   top gainer     the 5 best performers of the day (≥ +15%)
 *   capitulation   down ≥ 20% over 3 days while ≥ 30% of the universe is down ≥ 15% (a market-wide flush)
 *   squeeze        20-day range ≤ 15% of the price, then a close above it
 *   RS leader      30-day return beats BTC's by ≥ 30% and the close is within 5% of the 20-day high
 *
 * For each: n, mean next-day return, median, P(≥ +5% / +10% / +15%), P(≤ −10%), mean after a
 * 0.2% cost; then, holding instead until a close 2 × ATR(14) under the best close (≤ 20 days),
 * the mean per trade. IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/daily-movers.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { atr14 } from "./intraday-edge";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const DAY = 86_400;
const SPLIT = Date.UTC(2024, 6, 1) / 1000;
const COST = 0.002;
const SCREENS = ["base rate", "breakout+vol", "top gainer", "capitulation", "squeeze", "RS leader"] as const;
type Screen = (typeof SCREENS)[number];

interface Obs {
  t: number;
  next: number; // next day's return
  trail: number; // held with a 2×ATR trail (≤ 20 days)
}

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const btc = new Map((JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "klines", "1d", "BTCUSDT.json"), "utf8")) as ResearchBar[]).map((b) => [b.time, b.close]));
  // per coin-day candidates, before the cross-sectional screens
  interface Row {
    t: number;
    ret1: number;
    ret3: number;
    next: number;
    trail: number;
    breakout: boolean;
    volx: number;
    squeeze: boolean;
    rs30: number | null;
    nearHigh: boolean;
  }
  const rows: Row[] = [];
  for (const s of symbols) {
    const file = path.join(CACHE_DIR, "klines", "1d", `${s}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")) as ResearchBar[], 3 * 86_400_000)) {
      if (c.length < 60) continue;
      const a = atr14(c);
      for (let i = 31; i < c.length - 1; i++) {
        let q = 0;
        for (let j = i - 30; j < i; j++) q += c[j].quoteVolume;
        if (q / 30 < 2e6) continue;
        let hi20 = -Infinity;
        let lo20 = Infinity;
        for (let j = i - 20; j < i; j++) {
          hi20 = Math.max(hi20, c[j].high);
          lo20 = Math.min(lo20, c[j].low);
        }
        // hold with a 2×ATR trail from the best close, ≤ 20 days
        let best = c[i].close;
        let exit = c[Math.min(c.length - 1, i + 20)].close;
        for (let x = i + 1; x <= Math.min(c.length - 1, i + 20); x++) {
          if (c[x].close < best - 2 * a[x - 1]) {
            exit = c[x].close;
            break;
          }
          best = Math.max(best, c[x].close);
        }
        const b0 = btc.get(c[i - 30].time);
        const b1 = btc.get(c[i].time);
        rows.push({
          t: c[i].time,
          ret1: c[i].close / c[i - 1].close - 1,
          ret3: c[i].close / c[i - 3].close - 1,
          next: c[i + 1].close / c[i].close - 1,
          trail: exit / c[i].close - 1,
          breakout: c[i].close > hi20,
          volx: c[i].quoteVolume / (q / 30),
          squeeze: (hi20 - lo20) / c[i].close <= 0.15 && c[i].close > hi20,
          rs30: b0 && b1 ? c[i].close / c[i - 30].close - b1 / b0 : null,
          nearHigh: c[i].close >= 0.95 * hi20,
        });
      }
    }
  }
  // cross-section per day
  const byDay = new Map<number, Row[]>();
  for (const r of rows) (byDay.get(r.t) ?? byDay.set(r.t, []).get(r.t)!).push(r);
  const obs = new Map<Screen, Obs[]>(SCREENS.map((s) => [s, []]));
  for (const [t, rs] of byDay) {
    const flush = rs.filter((r) => r.ret3 <= -0.15).length / rs.length >= 0.3;
    const top = [...rs].sort((a, b) => b.ret1 - a.ret1).slice(0, 5).filter((r) => r.ret1 >= 0.15);
    const add = (s: Screen, r: Row) => obs.get(s)?.push({ t, next: r.next, trail: r.trail });
    for (const r of rs) {
      add("base rate", r);
      if (r.breakout && r.volx >= 3) add("breakout+vol", r);
      if (flush && r.ret3 <= -0.2) add("capitulation", r);
      if (r.squeeze) add("squeeze", r);
      if (r.rs30 !== null && r.rs30 >= 0.3 && r.nearHigh) add("RS leader", r);
    }
    for (const r of top) add("top gainer", r);
  }

  const line = (xs: Obs[]) => {
    if (!xs.length) return "–";
    const n = xs.map((x) => x.next).sort((a, b) => a - b);
    const m = n.reduce((a, b) => a + b, 0) / n.length;
    const p = (f: (x: number) => boolean) => `${((100 * n.filter(f).length) / n.length).toFixed(1)}%`;
    const tr = xs.reduce((a, x) => a + x.trail, 0) / xs.length;
    return `n ${String(xs.length).padStart(6)} · next day mean ${pct(m, 2).padStart(7)} median ${pct(n[Math.floor(n.length / 2)], 2).padStart(7)} · ≥+5% ${p((x) => x >= 0.05).padStart(5)} ≥+10% ${p((x) => x >= 0.1).padStart(5)} ≥+15% ${p((x) => x >= 0.15).padStart(5)} · ≤−10% ${p((x) => x <= -0.1).padStart(5)} · net ${pct(m - COST, 2).padStart(7)} │ trail ${pct(tr - COST, 1).padStart(6)}`;
  };
  console.log("Next day (close → close) after each screen · IS 2021 → 2024-06 / OOS after\n");
  for (const s of SCREENS) {
    const xs = obs.get(s) ?? [];
    console.log(s);
    console.log(`  IS  ${line(xs.filter((x) => x.t < SPLIT))}`);
    console.log(`  OOS ${line(xs.filter((x) => x.t >= SPLIT))}`);
  }

  // a daily book: buy every candidate of a screen at the close, equal weight, sell the next close
  console.log("\nDaily book (equal weight across that day's candidates, sell the next close, cost 0.2%): days with a trade · mean day · share of days ≥ +5% · ≤ −5% · compounded per year");
  for (const s of SCREENS.slice(1)) {
    for (const [label, f] of [["IS ", (t: number) => t < SPLIT], ["OOS", (t: number) => t >= SPLIT]] as const) {
      const days = new Map<number, number[]>();
      for (const x of (obs.get(s) ?? []).filter((x) => f(x.t))) (days.get(x.t) ?? days.set(x.t, []).get(x.t)!).push(x.next - COST);
      const d = [...days.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
      if (!d.length) continue;
      const span = label === "IS " ? 3.5 : 2.25;
      const g = d.reduce((a, r) => a * (1 + r), 1);
      console.log(`  ${s.padEnd(13)} ${label} ${String(d.length).padStart(4)} days · mean ${pct(d.reduce((a, b) => a + b, 0) / d.length, 2).padStart(7)} · ≥+5% ${((100 * d.filter((x) => x >= 0.05).length) / d.length).toFixed(0).padStart(2)}% · ≤−5% ${((100 * d.filter((x) => x <= -0.05).length) / d.length).toFixed(0).padStart(2)}% · ${pct(g ** (1 / span) - 1, 0)} per year`);
    }
  }
}

if (process.argv[1]?.endsWith("daily-movers.ts")) void main();
