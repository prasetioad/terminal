/**
 * The owner's method on WEEKLY candles: buy when a MaxFlow+ green dot is followed by a
 * Stochastic cross up from below 20 (5,3,3 or 14,3,3), exit at the first red dot. Rules as
 * Setup v1's engine (lib/setups/setupV1.ts), copied here because the warmup differs on 1W
 * (52 weeks instead of 220 bars). No higher-timeframe bias: a first run with a 4-week bias let
 * 37 trades through in 524 pairs — weekly green dots come at cycle lows, when the monthly trend
 * is down by definition (BTC: Dec 2018, Jun 2022, Dec 2025, Feb 2026). The bot and scanner
 * are untouched.
 *
 *   W1  dot + stoch, stop −15% (as v1)
 *   W2  dot + stoch, stop −30% (weekly ranges are wider)
 *   W3  the green dot alone (entry on the week it is known), stop −30%
 *
 * Data: Binance weekly klines since 2017 from the API for pairs still listed; delisted pairs
 * from the 4h cache (since 2021), weeks starting Monday 00:00 UTC as Binance's. Before 2021
 * only today's survivors are in, so that stretch is shown apart. Pairs ≥ $1M/day.
 * Costs 0.2% per round trip. IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/weekly.ts
 */
import fs from "node:fs";
import path from "node:path";
import { computeMaxFlow } from "../lib/maxflow";
import { stochastic } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { CACHE_DIR, archiveSymbols, slot, type ResearchBar } from "./data";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const DAY = 86_400;
const WEEK = 7 * DAY;
const MONDAY = 4 * DAY; // 1970-01-01 was a Thursday
const SPLIT = Date.UTC(2024, 6, 1);
const START = Date.UTC(2021, 0, 1);
const COST = 0.002;
const WARMUP = 52;
const DIR = path.join(CACHE_DIR, "klines", "1w");

const weekOf = (t: number) => Math.floor((t - MONDAY) / WEEK) * WEEK + MONDAY;

function fromFourHour(symbol: string): ResearchBar[] | null {
  const file = path.join(CACHE_DIR, "klines", "4h", `${symbol}.json`);
  if (!fs.existsSync(file)) return null;
  const out: ResearchBar[] = [];
  for (const b of JSON.parse(fs.readFileSync(file, "utf8")) as ResearchBar[]) {
    const t = weekOf(b.time);
    const w = out.at(-1);
    if (w && w.time === t) {
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.volume += b.volume;
      w.quoteVolume += b.quoteVolume;
      w.buyVolume = (w.buyVolume ?? 0) + (b.buyVolume ?? 0);
    } else out.push({ ...b, time: t as ResearchBar["time"] });
  }
  return out;
}

/** Weekly bars: the API's full history for a listed pair, else built from the 4h cache. */
async function weekly(symbol: string): Promise<ResearchBar[] | null> {
  const file = path.join(DIR, `${symbol}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const res = await slot(() => fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1w&startTime=${Date.UTC(2017, 0, 1)}&limit=1000`));
  let bars: ResearchBar[] | null = null;
  if (res.ok) {
    const rows = (await res.json()) as (string | number)[][];
    const closed = rows.filter((k) => Number(k[6]) < Date.now());
    if (closed.length) bars = closed.map((k) => ({ time: (Number(k[0]) / 1000) as Candle["time"], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7], buyVolume: +k[9] }));
  }
  bars ??= fromFourHour(symbol);
  if (!bars) return null;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

interface Trade {
  symbol: string;
  at: number; // ms, entry (the signal week's close)
  exitAt: number;
  ret: number; // net of costs
  weeks: number;
  reason: "stop" | "signal" | "open";
}

/** Setup v1's rules on weekly bars; `stopPct` the stop under the entry. */
function run(symbol: string, c: ResearchBar[], stopPct: number, dotOnly = false): Trade[] {
  const n = c.length;
  if (n <= WARMUP + 2) return [];
  const mf = computeMaxFlow(c as unknown as Candle[], {
    scalping: false, obosFilter: true, divergence: false, hiddenDivergence: false, mtf: false, htfMs: WEEK * 1000, intervalMs: WEEK * 1000,
    dynamicBands: false, atrLength: 14, volumeArea: false, earlyWarning: false, mfLength: 14, mfSmooth: 3, vwapLength: 8,
  });
  const green = new Uint8Array(n);
  for (const d of mf.dots) if (d.kind === "green" && d.index + 1 < n) green[d.index + 1] = 1;
  const red = new Uint8Array(n);
  for (let i = 1; i + 1 < n; i++) if (mf.wt1[i] < mf.wt2[i] && mf.wt1[i - 1] >= mf.wt2[i - 1] && mf.wt1[i] > 0) red[i + 1] = 1;
  const fast = stochastic(c as unknown as Candle[], 5, 3, 3);
  const slow = stochastic(c as unknown as Candle[], 14, 3, 3);
  const cross = (s: { k: number[]; d: number[] }, i: number) => s.k[i] > s.d[i] && s.k[i - 1] <= s.d[i - 1] && Math.min(s.k[i - 1], s.d[i - 1]) < 20;
  const trades: Trade[] = [];
  let s = WARMUP;
  while (s < n) {
    let dot = false;
    for (let j = s; j >= s - 5; j--) if (green[j]) dot = true;
    if (dotOnly ? !green[s] : !dot || !(cross(fast, s) || cross(slow, s))) {
      s++;
      continue;
    }
    // ≥ $1M/day over the last 4 weeks
    const q = c.slice(Math.max(0, s - 3), s + 1).reduce((a, b) => a + b.quoteVolume, 0) / (Math.min(4, s + 1) * 7);
    if (q < 1e6) {
      s++;
      continue;
    }
    const entry = c[s].close;
    const stop = entry * (1 - stopPct);
    let x = s + 1;
    let t: Trade | null = null;
    for (; x < n; x++) {
      if (c[x].time - c[x - 1].time > 2 * WEEK) break; // a gap: the history ends here
      if (c[x].low <= stop) {
        t = { symbol, at: (c[s].time + WEEK) * 1000, exitAt: (c[x].time + WEEK) * 1000, ret: Math.min(c[x].open, stop) / entry - 1 - COST, weeks: x - s, reason: "stop" };
        break;
      }
      if (red[x]) {
        t = { symbol, at: (c[s].time + WEEK) * 1000, exitAt: (c[x].time + WEEK) * 1000, ret: c[x].close / entry - 1 - COST, weeks: x - s, reason: "signal" };
        break;
      }
    }
    if (!t) {
      const last = Math.min(x, n) - 1;
      trades.push({ symbol, at: (c[s].time + WEEK) * 1000, exitAt: (c[last].time + WEEK) * 1000, ret: c[last].close / entry - 1 - COST, weeks: last - s, reason: "open" });
      break;
    }
    trades.push(t);
    s = x + 1;
  }
  return trades;
}

function line(xs: Trade[]) {
  if (!xs.length) return "–";
  const rs = xs.map((t) => t.ret).sort((a, b) => a - b);
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, r) => a + (r - m) ** 2, 0) / Math.max(1, rs.length - 1));
  const win = xs.filter((t) => t.ret > 0).length / xs.length;
  const weeks = xs.reduce((a, t) => a + t.weeks, 0) / xs.length;
  const stops = xs.filter((t) => t.reason === "stop").length / xs.length;
  const open = xs.filter((t) => t.reason === "open").length;
  return `n ${String(xs.length).padStart(4)}${open ? ` (${open} open)` : ""} · win ${(100 * win).toFixed(0)}% · mean ${pct(m, 1).padStart(7)} (t ${((m / sd) * Math.sqrt(xs.length)).toFixed(1).padStart(4)}) · median ${pct(rs[Math.floor(rs.length / 2)], 1).padStart(7)} · stopped ${(100 * stops).toFixed(0)}% · hold ${weeks.toFixed(1)} wk`;
}

/** Equal risk: each trade risks 1% of equity at its stop (position = 1% ÷ stop), ≤ 15 open; closed trades compound. */
function portfolio(xs: Trade[], stopPct: number, from: number, to: number) {
  const ts = xs.filter((t) => t.at >= from && t.at < to).sort((a, b) => a.at - b.at);
  let equity = 1;
  let peak = 1;
  let dd = 0;
  const open: { exitAt: number; pnl: number }[] = [];
  const settle = (until: number) => {
    open.sort((a, b) => a.exitAt - b.exitAt);
    while (open.length && open[0].exitAt <= until) {
      equity += open.shift()?.pnl ?? 0;
      peak = Math.max(peak, equity);
      dd = Math.min(dd, equity / peak - 1);
    }
  };
  for (const t of ts) {
    settle(t.at);
    if (open.length >= 15) continue;
    open.push({ exitAt: t.exitAt, pnl: equity * (0.01 / stopPct) * t.ret });
  }
  settle(Number.POSITIVE_INFINITY);
  const years = (Math.min(to, Date.now()) - from) / (365.25 * 86_400_000);
  return `CAGR ${pct(equity ** (1 / years) - 1).padStart(7)} · max DD ${pct(dd).padStart(7)} (closed trades)`;
}

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const series = new Map<string, ResearchBar[]>();
  await Promise.all(
    symbols.map(async (s) => {
      const w = await weekly(s).catch(() => null);
      if (w && w.length > WARMUP + 2) series.set(s, w);
    }),
  );
  const variants: [string, number][] = [
    ["W1 dot + stoch, stop −15%", 0.15],
    ["W2 dot + stoch, stop −30%", 0.3],
    ["W3 dot alone, stop −30%", 0.3],
  ];
  const sets = [
    [...series].flatMap(([s, c]) => run(s, c, 0.15)),
    [...series].flatMap(([s, c]) => run(s, c, 0.3)),
    [...series].flatMap(([s, c]) => run(s, c, 0.3, true)),
  ];
  const pick = (k: number): Trade[] => sets[k];
  console.log(`${series.size} pairs with ≥ ${WARMUP + 3} weeks · weekly · costs 0.2%\n`);
  variants.forEach(([name, stop], k) => {
    // open trades count at their last close: leaving them out would keep the running winners out
    // while every stopped loser is in
    const xs = pick(k);
    console.log(name);
    console.log(`  2017–2020 (survivors only) ${line(xs.filter((t) => t.at < START))}`);
    console.log(`  IS 2021 → 2024-06          ${line(xs.filter((t) => t.at >= START && t.at < SPLIT))}`);
    console.log(`  OOS 2024-07 → now          ${line(xs.filter((t) => t.at >= SPLIT))}`);
    const years: string[] = [];
    for (let y = 2018; y <= 2026; y++) {
      const ys = xs.filter((t) => new Date(t.at).getUTCFullYear() === y);
      if (ys.length) years.push(`${y} ${pct(ys.reduce((a, t) => a + t.ret, 0) / ys.length, 0)} (${ys.length})`);
    }
    console.log(`  per year (mean per trade): ${years.join(" · ")}`);
    console.log(`  portfolio 1% risk, ≤ 15 open: IS ${portfolio(pick(k), stop, START, SPLIT)} │ OOS ${portfolio(pick(k), stop, SPLIT, Date.now())}`);
    const open = pick(k).filter((t) => t.reason === "open");
    const weeks = new Map<number, number>();
    for (const t of xs) weeks.set(t.at, (weeks.get(t.at) ?? 0) + 1);
    const busiest = [...weeks].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  signals cluster: ${weeks.size} distinct weeks; busiest ${busiest.map(([w, v]) => `${new Date(w).toISOString().slice(0, 10)} (${v})`).join(", ")}`);
    console.log(`  still open now: ${open.length}${open.length ? ` (${open.slice(0, 8).map((t) => `${t.symbol.replace("USDT", "")} ${pct(t.ret, 0)}`).join(", ")})` : ""}\n`);
  });
  const best = pick(0).filter((t) => t.at >= START).sort((a, b) => b.ret - a.ret);
  console.log(`Largest W1 trades since 2021: ${best.slice(0, 8).map((t) => `${t.symbol.replace("USDT", "")} ${pct(t.ret, 0)} (${new Date(t.at).toISOString().slice(0, 7)}, ${t.weeks} wk)`).join(" · ")}`);
}

if (process.argv[1]?.endsWith("weekly.ts")) void main();
