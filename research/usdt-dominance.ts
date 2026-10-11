/**
 * USDT dominance and the bot's setups (owner's question): USDT.D rises when coins fall and falls
 * when they rise — is that information, and can it improve v1.2 + Setup A?
 *
 * USDT.D = USDT's market cap ÷ the total crypto market cap. The total's history is not free
 * (CoinGecko: PRO only), so this uses a proxy: USDT ÷ (BTC + ETH market cap). BTC and ETH are
 * ~65–70% of the total, so the proxy moves with USDT.D. USDT supply: DefiLlama (daily). BTC / ETH
 * caps: daily close × circulating supply (interpolated from known yearly values).
 *
 *   1  same-day link: daily change of the proxy against the equal-weight return of the liquid
 *      universe — expected strongly negative by construction (USDT supply moves slowly)
 *   2  does it lead? next 7 days' universe return by the proxy's last-7-day change (quintiles),
 *      and above / below its 50-day average
 *   3  regime filters on the bot's portfolio (4h, the bot's rules, cost 0.2%), each signal from
 *      the day before the entry: risk-on only (proxy below its 50-day average) · proxy falling
 *      over 7 days · v1.2 only in fear (above the average) and A only in risk-on · USDT supply
 *      growing over 30 days (new money)
 *
 * IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/usdt-dominance.ts
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_A, runSetupA } from "../lib/setups/setupA";
import { SETUP_V1, runSetupV1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { type AT, type V1T, toTrade } from "./audit";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const DAY = 86_400;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);

/** Circulating supply at the start of each year (BTC: issuance schedule; ETH: post-merge ≈ flat). */
const SUPPLY: Record<string, [number, number][]> = {
  BTC: [[2021, 18.58e6], [2022, 18.92e6], [2023, 19.25e6], [2024, 19.58e6], [2025, 19.81e6], [2026, 19.98e6], [2027, 20.14e6]],
  ETH: [[2021, 114.0e6], [2022, 119.0e6], [2023, 120.5e6], [2024, 120.2e6], [2025, 120.5e6], [2026, 120.7e6], [2027, 120.9e6]],
};
export function supply(coin: "BTC" | "ETH", t: number): number {
  const y = new Date(t * 1000).getUTCFullYear() + new Date(t * 1000).getUTCMonth() / 12 + new Date(t * 1000).getUTCDate() / 365;
  const pts = SUPPLY[coin];
  for (let k = 0; k + 1 < pts.length; k++) if (y < pts[k + 1][0]) return pts[k][1] + ((y - pts[k][0]) / (pts[k + 1][0] - pts[k][0])) * (pts[k + 1][1] - pts[k][1]);
  return pts[pts.length - 1][1];
}

export async function usdtSupply(): Promise<Map<number, number>> {
  const file = path.join(CACHE_DIR, "usdt-supply.json");
  if (!fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > 86_400_000) {
    const res = await fetch("https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=1");
    if (!res.ok) throw new Error(`DefiLlama HTTP ${res.status}`);
    fs.writeFileSync(file, await res.text());
  }
  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as { date: string; totalCirculatingUSD: { peggedUSD: number } }[];
  return new Map(rows.map((r) => [Math.floor(Number(r.date) / DAY) * DAY, r.totalCirculatingUSD.peggedUSD]));
}

const daily = (symbol: string): ResearchBar[] => JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "klines", "1d", `${symbol}.json`), "utf8"));

/** The bot's v1.2 (first dot, with breadth) and Setup A trades on 4h, cost 0.2% (0.1% on top of the research's). */
export async function botTrades(symbols?: string[]): Promise<{ v1c: V1T[]; ac: AT[] }> {
  symbols ??= (await archiveSymbols()).filter(inUniverse);
  const btc4 = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "klines", "4h", "BTCUSDT.json"), "utf8")) as Candle[];
  const v1: V1T[] = [];
  const a: AT[] = [];
  const signals = new Map<number, number>();
  for (const s of symbols) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${s}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")) as ResearchBar[], 3 * 86_400_000)) {
      if (c.length < SETUP_V1.warmup + 30) continue;
      const candles = c as unknown as Candle[];
      const base = runSetupV1(candles, { stoch: "either", intervalMs: H4 });
      for (const t of [...base.trades, ...(base.open ? [base.open] : [])]) signals.set(t.entryTime + H4, (signals.get(t.entryTime + H4) ?? 0) + 1);
      const first = runSetupV1(candles, { stoch: "either", intervalMs: H4, firstDotOnly: true });
      for (const t of [...first.trades, ...(first.open ? [first.open] : [])]) v1.push({ ...toTrade(s, c, H4, 0, t.entryIndex, t.exitIndex, t.exitPrice, SETUP_V1.stopPct), breadth: 0 });
      const ra = runSetupA(candles, H4, { btc: btc4, spikeTighten: SETUP_A.spikeTighten });
      for (const t of [...ra.trades, ...(ra.open ? [ra.open] : [])]) a.push({ ...toTrade(s, c, H4, 0, t.entryIndex, t.exitIndex, t.exitPrice, 1 - t.stopPrice / t.entryPrice), rsA: t.rs, surgeA: t.surge });
    }
  }
  for (const t of v1) t.breadth = signals.get(t.at) ?? 0;
  const cost = <T extends Trade>(ts: T[]): T[] => ts.map((t) => ({ ...t, exit: t.exit * 0.999, closes: [...t.closes.slice(0, -1), (t.closes.at(-1) ?? t.exit) * 0.999] }));
  return { v1c: cost(v1), ac: cost(a) };
}

async function main() {
  const usdt = await usdtSupply();
  const btc = new Map(daily("BTCUSDT").map((b) => [b.time, b.close]));
  const eth = new Map(daily("ETHUSDT").map((b) => [b.time, b.close]));
  // the proxy per UTC day (seconds)
  const days: number[] = [];
  const dom = new Map<number, number>();
  const sup = new Map<number, number>();
  for (const [t, b] of btc) {
    const e = eth.get(t);
    const u = usdt.get(t);
    if (e === undefined || u === undefined || t * 1000 < START - 400 * 86_400_000) continue;
    dom.set(t, u / (b * supply("BTC", t) + e * supply("ETH", t)));
    sup.set(t, u);
    days.push(t);
  }
  days.sort((a, b) => a - b);
  const ma = (k: number, len: number) => {
    let s = 0;
    for (let j = k - len + 1; j <= k; j++) s += dom.get(days[j]) ?? 0;
    return s / len;
  };
  const sig = new Map<number, { dom: number; ma50: number; ch7: number; sup30: number }>();
  for (let k = 50; k < days.length; k++) {
    const t = days[k];
    sig.set(t, { dom: dom.get(t) ?? 0, ma50: ma(k, 50), ch7: (dom.get(t) ?? 0) / (dom.get(days[k - 7]) ?? 1) - 1, sup30: (sup.get(t) ?? 0) / (sup.get(days[k - 30]) ?? 1) - 1 });
  }
  const latest = days[days.length - 1];
  console.log(`proxy USDT ÷ (BTC+ETH) on ${new Date(latest * 1000).toISOString().slice(0, 10)}: ${(100 * (dom.get(latest) ?? 0)).toFixed(2)}%`);

  // equal-weight daily return of the liquid universe
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const sum = new Map<number, number>();
  const cnt = new Map<number, number>();
  for (const s of symbols) {
    const file = path.join(CACHE_DIR, "klines", "1d", `${s}.json`);
    if (!fs.existsSync(file)) continue;
    const c: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    for (let i = 30; i < c.length; i++) {
      if (c[i].time - c[i - 1].time !== DAY) continue;
      let q = 0;
      for (let j = i - 30; j < i; j++) q += c[j].quoteVolume;
      if (q / 30 < 5e6) continue;
      const r = c[i].close / c[i - 1].close - 1;
      if (Math.abs(r) > 0.9) continue;
      sum.set(c[i].time, (sum.get(c[i].time) ?? 0) + r);
      cnt.set(c[i].time, (cnt.get(c[i].time) ?? 0) + 1);
    }
  }
  const uni = new Map([...sum].map(([t, s]) => [t, s / (cnt.get(t) ?? 1)]));
  const corr = (xs: number[], ys: number[]) => {
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let k = 0; k < xs.length; k++) {
      sxy += (xs[k] - mx) * (ys[k] - my);
      sxx += (xs[k] - mx) ** 2;
      syy += (ys[k] - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
  };

  console.log("\n1 · SAME DAY: daily change of the proxy vs the universe's equal-weight return");
  for (const [label, from, to] of [["IS", START, SPLIT], ["OOS", SPLIT, END]] as const) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 1; k < days.length; k++) {
      const t = days[k];
      if (t * 1000 < from || t * 1000 >= to || !uni.has(t)) continue;
      xs.push((dom.get(t) ?? 0) / (dom.get(days[k - 1]) ?? 1) - 1);
      ys.push(uni.get(t) ?? 0);
    }
    console.log(`  ${label}: correlation ${corr(xs, ys).toFixed(2)} (${xs.length} days)`);
  }

  console.log("\n2 · DOES IT LEAD? next 7 days' universe return (compounded), by the proxy's state at the day's close");
  const fwd = (k: number) => {
    let g = 1;
    for (let j = k + 1; j <= k + 7 && j < days.length; j++) g *= 1 + (uni.get(days[j]) ?? 0);
    return g - 1;
  };
  for (const [label, from, to] of [["IS", START, SPLIT], ["OOS", SPLIT, END]] as const) {
    const rows: { ch7: number; above: boolean; f: number }[] = [];
    for (let k = 50; k + 7 < days.length; k++) {
      const t = days[k];
      const s = sig.get(t);
      if (!s || t * 1000 < from || t * 1000 >= to) continue;
      rows.push({ ch7: s.ch7, above: s.dom > s.ma50, f: fwd(k) });
    }
    rows.sort((a, b) => a.ch7 - b.ch7);
    const qn = 5;
    const qs: string[] = [];
    for (let k = 0; k < qn; k++) {
      const part = rows.slice(Math.floor((k * rows.length) / qn), Math.floor(((k + 1) * rows.length) / qn));
      qs.push(`Q${k + 1} ${pct(part.reduce((a, r) => a + r.f, 0) / part.length, 1)}`);
    }
    const m = (v: typeof rows) => pct(v.reduce((a, r) => a + r.f, 0) / Math.max(1, v.length), 1);
    console.log(`  ${label}: by last-7-day change (Q1 = proxy fell most → Q5 = rose most): ${qs.join(" · ")}`);
    console.log(`  ${label}: proxy above its 50-day average ${m(rows.filter((r) => r.above))} (${rows.filter((r) => r.above).length} days) · below ${m(rows.filter((r) => !r.above))} (${rows.filter((r) => !r.above).length} days) · all ${m(rows)}`);
  }

  // 3 · regime filters on the bot's portfolio
  const { v1c, ac } = await botTrades(symbols);
  /** The signal known at the entry: the last complete UTC day before the decision time. */
  const known = (t: Trade) => sig.get(Math.floor(t.at / 1000 / DAY) * DAY - DAY);
  type Gate = (t: Trade) => boolean;
  const all: Gate = () => true;
  const riskOn: Gate = (t) => {
    const s = known(t);
    return !!s && s.dom < s.ma50;
  };
  const fear: Gate = (t) => {
    const s = known(t);
    return !!s && s.dom > s.ma50;
  };
  const falling: Gate = (t) => {
    const s = known(t);
    return !!s && s.ch7 < 0;
  };
  const minting: Gate = (t) => {
    const s = known(t);
    return !!s && s.sup30 > 0;
  };
  const book = (g1: Gate, gA: Gate): Sleeve[] => [
    { trades: v1c, accept: (t) => (t as V1T).breadth >= SETUP_V1.minBreadth && g1(t), risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 },
    { trades: ac, accept: (t) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs && gA(t), risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025 },
  ];
  const row = (r: Result) => `CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(5)} · ${r.perYear.toFixed(0).padStart(4)}/y win ${(100 * r.win).toFixed(0)}%`;
  const both = (label: string, s: Sleeve[]) => console.log(`  ${label.padEnd(44)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);
  console.log("\n3 · REGIME FILTERS ON THE BOT (4h, cost 0.2%) — IS │ OOS");
  both("today (no filter)", book(all, all));
  both("risk-on only (proxy < 50-day avg)", book(riskOn, riskOn));
  both("proxy falling over 7 days", book(falling, falling));
  both("v1.2 in fear, A in risk-on", book(fear, riskOn));
  both("v1.2 any, A in risk-on", book(all, riskOn));
  both("USDT supply growing (30 days)", book(minting, minting));
  console.log("  per setup, today vs risk-on only:");
  both("    v1.2 today", [book(all, all)[0]]);
  both("    v1.2 risk-on only", [book(riskOn, riskOn)[0]]);
  both("    v1.2 fear only", [book(fear, fear)[0]]);
  both("    A today", [book(all, all)[1]]);
  both("    A risk-on only", [book(riskOn, riskOn)[1]]);
  both("    A fear only", [book(fear, fear)[1]]);
}

if (process.argv[1]?.endsWith("usdt-dominance.ts")) void main();
