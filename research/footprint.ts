/**
 * Fabio Valentini's two models with real order flow: the auction trades of research/auction.ts
 * (previous-day value area on 5m bars, retest of VAH/VAL that holds → continuation, that fails
 * → reversion to the POC, long and short), confirmed by footprint features built from
 * Binance aggTrades (research/aggtrades.ts). Rules fixed before looking at results:
 *
 *   continuation + initiative   the retest bar's aggressors push the trade's way: delta
 *       (buy − sell) / volume ≥ +0.10 for a long (≤ −0.10 for a short) and the big trades
 *       (≥ the previous day's 99th percentile) lean the same way (bigBuy > bigSell for a long)
 *   reversion + absorption      the breakout side's aggression is absorbed on the retest bar:
 *       for a long back from below VAL, aggressive selling in the bar's lowest 20% is ≥ 25% of
 *       its volume and it closes in the upper 40% of its range (a short from above VAH: the
 *       mirror, buying into the high and a close in the lower 40%)
 *   + NY session                the above, entries 13:30–20:00 UTC only
 *
 * Two timeframes: 5m (as auction.ts; the retest bar's footprint = its five 1-minute bars) and
 * 1m (previous day's 1,440 bars, retest within 30 bars, tol 0.02%, buffer 0.03%, stops
 * 0.05–1%, out after 60 bars). Stops,
 * targets and exits as in auction.ts. Also: the next 30 minutes after a retest, by the retest
 * bar's delta (what order flow says, with no rule on top).
 *
 * Pairs and months: research/aggtrades.ts (IS 2024-01 → 06, OOS 2026-03 → 08). Gross = the
 * break-even cost; net at 0.04% (futures maker) and 0.1% (futures taker).
 *
 *   npx tsx research/aggtrades.ts   (data, once)
 *   npx tsx research/footprint.ts
 */
import fs from "node:fs";
import { FOOTPRINT_MONTHS, FOOTPRINT_PAIRS, footprintFile, type Footprint } from "./aggtrades";
import { segments, type ResearchBar } from "./data";
import { stats, type Sample } from "./intraday-edge";
import { pct } from "./momentum";
import { INTRADAY, dailyLevels, type Scale } from "./value-area";

const SPLIT = Date.UTC(2025, 0, 1);
const DAY = 86_400;
const NY_FROM = 13.5 * 3600;
const NY_TO = 20 * 3600;

/** 5m as in auction.ts; 1m: the previous day's 1,440 bars, retest within 30 minutes, stops 0.05–1%, out after 1h. */
export const SCALES: Scale[] = [
  INTRADAY,
  { name: "1m", barMs: 60_000, profileBars: 1440, window: 30, tol: 0.0002, buf: 0.0003, minStop: 0.0005, maxStop: 0.01, hold: 60 },
];

type Dir = 1 | -1;
export interface Bar extends ResearchBar {
  buyQ: number;
  sellQ: number;
  bigBuy: number;
  bigSell: number;
  sellLow: number;
  buyHigh: number;
}

/** 1-minute footprint → bars of `sec` seconds (flows summed; sellLow/buyHigh summed over the minutes). */
export function toBars(f: Footprint, sec: number): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < f.t.length; k++) {
    const t = Math.floor(f.t[k] / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, f.h[k]);
      last.low = Math.min(last.low, f.l[k]);
      last.close = f.c[k];
      last.volume += f.v[k];
      last.quoteVolume += f.q[k];
      last.buyQ += f.buy[k];
      last.sellQ += f.sell[k];
      last.bigBuy += f.bigBuy[k];
      last.bigSell += f.bigSell[k];
      last.sellLow += f.sellLow[k];
      last.buyHigh += f.buyHigh[k];
    } else {
      out.push({
        time: t as Bar["time"], buyVolume: 0, open: f.o[k], high: f.h[k], low: f.l[k], close: f.c[k], volume: f.v[k], quoteVolume: f.q[k],
        buyQ: f.buy[k], sellQ: f.sell[k], bigBuy: f.bigBuy[k], bigSell: f.bigSell[k], sellLow: f.sellLow[k], buyHigh: f.buyHigh[k],
      });
    }
  }
  for (const b of out) b.buyVolume = b.quoteVolume > 0 ? (b.volume * b.buyQ) / b.quoteVolume : 0;
  return out;
}

interface Trade extends Sample {
  reason: "stop" | "target" | "time";
}

function hold(S: Scale, c: Bar[], e: number, d: Dir, stop: number, target: number): Omit<Trade, "at"> & { bar: number } {
  const entry = c[e].close;
  const end = Math.min(c.length - 1, e + S.hold);
  for (let x = e + 1; x <= end; x++) {
    const b = c[x];
    if (d === 1 ? b.low <= stop : b.high >= stop) return { gross: (d * ((d === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - entry)) / entry, bar: x, reason: "stop" };
    if (d === 1 ? b.high >= target : b.low <= target) return { gross: (d * ((d === 1 ? Math.max(b.open, target) : Math.min(b.open, target)) - entry)) / entry, bar: x, reason: "target" };
  }
  return { gross: (d * (c[end].close - entry)) / entry, bar: end, reason: "time" };
}

const book = new Map<string, Trade[]>();
/** Forward 30-minute return (in the breakout's direction) after a retest, by the retest bar's delta. */
const flowBuckets = new Map<string, Sample[]>();

function scan(S: Scale, c: Bar[]) {
  const n = c.length;
  const lv = dailyLevels(c, S);
  const busy = new Map<string, number>();
  const take = (key: string, e: number, d: Dir, stop: number, target: number) => {
    if ((busy.get(key) ?? -1) >= e) return;
    const { bar, ...r } = hold(S, c, e, d, stop, target);
    busy.set(key, bar);
    const list = book.get(key) ?? [];
    list.push({ at: c[e].time * 1000 + S.barMs, ...r });
    book.set(key, list);
  };
  for (let i = 1; i < n - 2; i++) {
    const L = lv[i];
    if (!L) continue;
    for (const [edge, d] of [[L.vah, 1], [L.val, -1]] as const) {
      const beyond = (px: number) => (d === 1 ? px > edge : px < edge);
      if (!beyond(c[i].close) || beyond(c[i - 1].close)) continue;
      for (let j = i + 1; j <= Math.min(n - 2, i + S.window); j++) {
        const back = d === 1 ? c[j].low <= edge * (1 + S.tol) : c[j].high >= edge * (1 - S.tol);
        if (!back) continue;
        const b = c[j];
        const entry = b.close;
        const delta = b.quoteVolume > 0 ? (b.buyQ - b.sellQ) / b.quoteVolume : 0;
        // what order flow alone says: the next 30 minutes in the breakout's direction
        const ahead = Math.round(1_800_000 / S.barMs);
        if (j + ahead < n) {
          const bucket = d * delta >= 0.1 ? "delta with the breakout ≥ 0.10" : d * delta <= -0.1 ? "delta against the breakout ≥ 0.10" : "delta neutral";
          const list = flowBuckets.get(`${S.name} · ${bucket}`) ?? [];
          list.push({ at: b.time * 1000, gross: (d * (c[j + ahead].close - entry)) / entry });
          flowBuckets.set(`${S.name} · ${bucket}`, list);
        }
        const holds = beyond(entry);
        const t: Dir = holds ? d : (-d as Dir);
        let stop: number;
        let target: number;
        if (holds) {
          stop = d === 1 ? Math.min(b.low, edge) * (1 - S.buf) : Math.max(b.high, edge) * (1 + S.buf);
          target = entry + t * 2 * Math.abs(entry - stop);
        } else {
          let ext = d === 1 ? -Infinity : Infinity;
          for (let k = i; k <= j; k++) ext = d === 1 ? Math.max(ext, c[k].high) : Math.min(ext, c[k].low);
          stop = d === 1 ? ext * (1 + S.buf) : ext * (1 - S.buf);
          target = L.poc;
          if (t * (target - entry) < Math.abs(entry - stop)) break;
        }
        const sd = Math.abs(entry - stop) / entry;
        if (sd < S.minStop || sd > S.maxStop) break;

        const range = b.high - b.low;
        const pos = range > 0 ? (b.close - b.low) / range : 0.5;
        let flow: boolean;
        if (holds) {
          // initiative in the trade's direction
          flow = t === 1 ? delta >= 0.1 && b.bigBuy > b.bigSell : delta <= -0.1 && b.bigSell > b.bigBuy;
        } else {
          // the breakout side's aggression absorbed: a long from below VAL needs sellers absorbed at the low
          flow = t === 1 ? b.sellLow >= 0.25 * b.quoteVolume && pos >= 0.6 : b.buyHigh >= 0.25 * b.quoteVolume && pos <= 0.4;
        }
        const ny = b.time % DAY >= NY_FROM && b.time % DAY < NY_TO;
        const name = `${S.name} · ${d === 1 ? "VAH" : "VAL"} ${holds ? "continuation" : "fails → POC"} (${t === 1 ? "long" : "short"})`;
        take(`${name} · base`, j, t, stop, target);
        if (flow) take(`${name} · ${holds ? "initiative" : "absorption"}`, j, t, stop, target);
        if (flow && ny) take(`${name} · ${holds ? "initiative" : "absorption"} + NY`, j, t, stop, target);
        break;
      }
    }
  }
}

function main() {
  const have: string[] = [];
  for (const symbol of FOOTPRINT_PAIRS) {
    const raw: Footprint[] = [];
    for (const m of FOOTPRINT_MONTHS) {
      const file = footprintFile(symbol, m);
      if (fs.existsSync(file)) raw.push(JSON.parse(fs.readFileSync(file, "utf8")));
    }
    if (!raw.length) continue;
    have.push(`${symbol} (${raw.length} months)`);
    for (const S of SCALES) {
      const bars = raw.flatMap((f) => toBars(f, S.barMs / 1000));
      for (const c of segments(bars, 30 * 60_000) as Bar[][]) if (c.length >= S.profileBars * 2) scan(S, c);
    }
  }
  console.log(`${have.join(" · ")}\nIS 2024-01 → 06 │ OOS 2026-03 → 08 · 5m and 1m, previous-day value area, footprint from aggTrades\n`);

  console.log("ORDER FLOW ALONE: the 30 minutes after a retest, in the breakout's direction (IS │ OOS)");
  for (const [k, xs] of [...flowBuckets].sort()) {
    const f = (v: Sample[]) => {
      const s = stats(v);
      return s ? `n ${String(s.n).padStart(5)} · ${pct(s.g, 3).padStart(8)} (t ${s.t.toFixed(1).padStart(5)})` : "–";
    };
    console.log(`  ${k.padEnd(46)} ${f(xs.filter((t) => t.at < SPLIT))} │ ${f(xs.filter((t) => t.at >= SPLIT))}`);
  }

  console.log("\nPER TRADE: n · gross (t per event) · net maker 0.04% · net taker 0.1% · stop/target/time");
  const row = (xs: Trade[]) => {
    const s = stats(xs);
    if (!s) return "–";
    const share = (r: Trade["reason"]) => `${((100 * xs.filter((t) => t.reason === r).length) / xs.length).toFixed(0)}%`;
    return `n ${String(s.n).padStart(5)} · ${pct(s.g, 3).padStart(8)} (t ${s.eventT.toFixed(1).padStart(5)}) · ${pct(s.g - 0.0004, 3).padStart(8)} · ${pct(s.g - 0.001, 3).padStart(8)} · ${share("stop")}/${share("target")}/${share("time")}`;
  };
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    console.log(`  ${key}`);
    console.log(`    IS  ${row(xs.filter((t) => t.at < SPLIT))}`);
    console.log(`    OOS ${row(xs.filter((t) => t.at >= SPLIT))}`);
  }
}

if (process.argv[1]?.endsWith("footprint.ts")) main();
