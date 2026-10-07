/**
 * Order flow from Binance's public aggTrades archive (every aggregated trade with its
 * aggressor side), compacted into 1-minute footprint bars for research/footprint.ts:
 *
 *   OHLC, base volume, quote volume
 *   buy / sell   quote volume by aggressor (isBuyerMaker = the seller was the aggressor)
 *   bigBuy / bigSell   aggressive quote volume in trades ≥ the 99th percentile of the previous
 *                day's trade sizes (the first day of a month uses its own)
 *   sellLow / buyHigh  aggressive selling within the lowest 20% of the bar's range, buying
 *                within the highest 20% — selling into the low that does not push price
 *                lower is what absorption looks like on a footprint
 *
 * One file per pair and month in research/.cache/aggtrades/<SYMBOL>/<YYYY-MM>.json. The raw
 * trades are kept as the archive's zip in research/.cache/aggtrades-raw/<SYMBOL>/ for finer
 * timeframes later (a month compacted before the raw files were kept gets its zip downloaded
 * again). Resumable. Spot timestamps are in microseconds from 2025.
 *
 *   npx tsx research/aggtrades.ts                       (the default pairs and months)
 *   npx tsx research/aggtrades.ts XRPUSDT 2024-03       (one pair and month)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ARCHIVE, CACHE_DIR } from "./data";

export const FOOTPRINT_PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];
export const FOOTPRINT_MONTHS = ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05", "2024-06", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
const DIR = path.join(CACHE_DIR, "aggtrades");
const RAW = path.join(CACHE_DIR, "aggtrades-raw");

/** Columnar 1-minute footprint bars; `t` = open time in seconds. */
export interface Footprint {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  q: number[];
  buy: number[];
  sell: number[];
  bigBuy: number[];
  bigSell: number[];
  sellLow: number[];
  buyHigh: number[];
}

export const footprintFile = (symbol: string, month: string) => path.join(DIR, symbol, `${month}.json`);
/** The archive's zip of every aggregated trade for a pair and month. */
export const rawFile = (symbol: string, month: string) => path.join(RAW, symbol, `${symbol}-aggTrades-${month}.zip`);

/** Download to a file; a dropped connection retries the whole file (up to 6 tries, growing pauses). */
async function download(url: string, file: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(file));
      return;
    } catch (err) {
      fs.rmSync(file, { force: true });
      if (attempt >= 6) throw err;
      await new Promise((r) => setTimeout(r, 10_000 * attempt));
    }
  }
}

async function compact(symbol: string, month: string): Promise<string> {
  const out = footprintFile(symbol, month);
  const zip = rawFile(symbol, month);
  if (fs.existsSync(out) && fs.existsSync(zip)) return "cached";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  if (!fs.existsSync(zip)) {
    const part = `${zip}.part`;
    await download(`${ARCHIVE}/data/spot/monthly/aggTrades/${symbol}/${symbol}-aggTrades-${month}.zip`, part);
    fs.renameSync(part, zip);
  }
  if (fs.existsSync(out)) return "raw trades downloaded (footprint cached)";

  const f: Footprint = { t: [], o: [], h: [], l: [], c: [], v: [], q: [], buy: [], sell: [], bigBuy: [], bigSell: [], sellLow: [], buyHigh: [] };
  // trades of the current minute, to split by position in the bar's range once it closes
  let minute = -1;
  let px: number[] = [];
  let qq: number[] = [];
  let sellSide: boolean[] = [];
  let big = Number.POSITIVE_INFINITY;
  let daySizes: number[] = [];
  let day = -1;
  const flush = () => {
    if (minute < 0 || !px.length) return;
    let hi = -Infinity;
    let lo = Infinity;
    let v = 0;
    let q = 0;
    let buy = 0;
    let sell = 0;
    let bigBuy = 0;
    let bigSell = 0;
    for (let k = 0; k < px.length; k++) {
      hi = Math.max(hi, px[k]);
      lo = Math.min(lo, px[k]);
      const quote = px[k] * qq[k];
      v += qq[k];
      q += quote;
      if (sellSide[k]) {
        sell += quote;
        if (quote >= big) bigSell += quote;
      } else {
        buy += quote;
        if (quote >= big) bigBuy += quote;
      }
    }
    const zone = (hi - lo) * 0.2;
    let sellLow = 0;
    let buyHigh = 0;
    for (let k = 0; k < px.length; k++) {
      if (sellSide[k] && px[k] <= lo + zone) sellLow += px[k] * qq[k];
      if (!sellSide[k] && px[k] >= hi - zone) buyHigh += px[k] * qq[k];
    }
    f.t.push(minute * 60);
    f.o.push(px[0]);
    f.h.push(hi);
    f.l.push(lo);
    f.c.push(px[px.length - 1]);
    f.v.push(v);
    f.q.push(q);
    f.buy.push(buy);
    f.sell.push(sell);
    f.bigBuy.push(bigBuy);
    f.bigSell.push(bigSell);
    f.sellLow.push(sellLow);
    f.buyHigh.push(buyHigh);
  };
  const p99 = (xs: number[]) => {
    const s = Float64Array.from(xs).sort();
    return s[Math.floor(s.length * 0.99)];
  };

  const unzip = spawn("unzip", ["-p", zip]);
  const lines = readline.createInterface({ input: unzip.stdout, crlfDelay: Infinity });
  let firstDay = true;
  for await (const line of lines) {
    // aggTradeId, price, quantity, firstTradeId, lastTradeId, timestamp, isBuyerMaker, isBestMatch
    const cols = line.split(",");
    if (cols.length < 7 || !/^\d/.test(cols[0])) continue;
    const price = Number(cols[1]);
    const qty = Number(cols[2]);
    let ts = Number(cols[5]);
    if (ts > 1e14) ts = Math.floor(ts / 1000); // microseconds
    const m = Math.floor(ts / 60_000);
    const d = Math.floor(m / 1440);
    if (d !== day) {
      if (daySizes.length) {
        big = p99(daySizes);
        firstDay = false;
      }
      daySizes = [];
      day = d;
    }
    if (m !== minute) {
      flush();
      minute = m;
      px = [];
      qq = [];
      sellSide = [];
    }
    px.push(price);
    qq.push(qty);
    sellSide.push(cols[6] === "true" || cols[6] === "True");
    daySizes.push(price * qty);
    // the month's first day has no previous day: use its own first hour as the reference
    if (firstDay && daySizes.length === 50_000) big = p99(daySizes);
  }
  flush();
  await new Promise((r) => unzip.on("close", r));
  fs.writeFileSync(out, JSON.stringify(f));
  return `${f.t.length} minutes`;
}

async function main() {
  const [one, oneMonth] = process.argv.slice(2);
  const jobs = one ? [[one, oneMonth]] : FOOTPRINT_PAIRS.flatMap((s) => FOOTPRINT_MONTHS.map((m) => [s, m]));
  for (const [s, m] of jobs) {
    const t0 = Date.now();
    try {
      console.log(`${s} ${m}: ${await compact(s, m)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    } catch (err) {
      console.log(`${s} ${m}: failed — ${(err as Error).message} (re-run to retry)`);
    }
  }
}

if (process.argv[1]?.endsWith("aggtrades.ts")) void main();
