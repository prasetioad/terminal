/**
 * Binance USDT-M futures data for the research universe, from the public archive
 * (data.binance.vision; delisted contracts included), compacted per 4h bar:
 *
 *   funding   every funding payment (time, rate)
 *   metrics   5-minute snapshots → per 4h bar: open interest (contracts and USDT) and the
 *             top-trader / global long-short ratios at the bar's last snapshot, the taker
 *             buy/sell volume ratio averaged over the bar
 *   klines    perpetual 4h closes, for the basis against spot
 *
 *   npx tsx research/futures.ts            (resumable; ~350k small files on the first run)
 *
 * A spot coin maps to its perpetual (XUSDT, else 1000XUSDT / 1000000XUSDT, priced ×1000…).
 * Point in time: a bar's values come only from snapshots taken before the bar closed.
 */
import fs from "node:fs";
import path from "node:path";
import { ARCHIVE, CACHE_DIR, archiveSymbols, fetchWithRetry, listBucket, slot, unzipSingle } from "./data";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const FROM = Date.UTC(2021, 0, 1);
const DIR = path.join(CACHE_DIR, "futures");

export interface FuturesSeries {
  perp: string;
  /** Perp price ÷ spot price (1, 1000, 1000000). */
  mult: number;
  funding: { t: number; r: number }[]; // t: ms
  /** Per 4h bar (open time, seconds), aligned arrays. */
  bars: { t: number[]; oi: number[]; oiv: number[]; topAcc: number[]; topPos: number[]; global: number[]; taker: number[] };
  /** Perp 4h closes by bar open time (seconds). */
  klines: { t: number[]; close: number[] };
}

let perpCache: Set<string> | null = null;
async function perps(): Promise<Set<string>> {
  if (perpCache) return perpCache;
  const file = path.join(DIR, "perps.json");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DIR, { recursive: true });
    const prefixes = await listBucket("data/futures/um/monthly/fundingRate/", true);
    fs.writeFileSync(file, JSON.stringify(prefixes.map((p) => p.split("/").at(-2)!).filter(Boolean)));
  }
  perpCache = new Set(JSON.parse(fs.readFileSync(file, "utf8")) as string[]);
  return perpCache;
}

/** The perpetual of a spot symbol, if any. */
export async function perpFor(spot: string): Promise<{ perp: string; mult: number } | null> {
  const all = await perps();
  const base = spot.replace(/USDT$/, "");
  for (const [prefix, mult] of [["", 1], ["1000", 1000], ["1000000", 1e6]] as const) if (all.has(`${prefix}${base}USDT`)) return { perp: `${prefix}${base}USDT`, mult };
  return null;
}

const csvRows = (csv: string) => csv.split("\n").map((l) => l.trim().split(",")).filter((f) => f.length > 2 && /^\d/.test(f[0]));

/** A file's CSV; with `optional`, a missing file (404) is "" (keys generated without a listing). */
async function download(key: string, optional = false): Promise<string> {
  return slot(async () => {
    const res = await fetchWithRetry(`${ARCHIVE}/${key}`);
    if (optional && res.status === 404) return "";
    if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
    return unzipSingle(Buffer.from(await res.arrayBuffer()));
  });
}

const ym = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function months(from: number, to: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1));
  while (d.getTime() <= to) {
    out.push(ym(d.getTime()));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/**
 * The archive's keys under `prefix` from its listing; when the listing is refused (the
 * bucket listing throttles heavy use), the keys are generated from dates and missing
 * files are skipped.
 */
async function keysFor(prefix: string, dateOf: (key: string) => number, generate: () => string[]): Promise<{ keys: string[]; optional: boolean }> {
  try {
    return { keys: await zips(prefix, dateOf), optional: false };
  } catch {
    return { keys: generate().filter((k) => dateOf(k) >= FROM), optional: true };
  }
}

const fetchAll = async (k: { keys: string[]; optional: boolean }) => (await Promise.all(k.keys.map((key) => download(key, k.optional)))).filter(Boolean);

const zips = async (prefix: string, dateOf: (key: string) => number) =>
  (await listBucket(prefix, false)).filter((k) => k.endsWith(".zip") && dateOf(k) >= FROM);

const monthOf = (k: string) => {
  const m = k.match(/-(\d{4})-(\d{2})\.zip$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, 1) : 0;
};
const dayOf = (k: string) => {
  const m = k.match(/-(\d{4})-(\d{2})-(\d{2})\.zip$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : 0;
};
/** Archive timestamps: ms, µs from 2025 on, or "YYYY-MM-DD hh:mm:ss" (UTC) in metrics. */
const toMs = (v: string) => (/^\d+$/.test(v) ? (Number(v) > 1e14 ? Math.floor(Number(v) / 1000) : Number(v)) : Date.parse(`${v.replace(" ", "T")}Z`));

async function build(perp: string, mult: number): Promise<FuturesSeries> {
  // Funding: calc_time, funding_interval_hours, last_funding_rate
  const now = Date.now();
  const fPrefix = `data/futures/um/monthly/fundingRate/${perp}/`;
  const funding = (await fetchAll(await keysFor(fPrefix, monthOf, () => months(FROM, now).map((m) => `${fPrefix}${perp}-fundingRate-${m}.zip`))))
    .flatMap(csvRows)
    .map((f) => ({ t: toMs(f[0]), r: Number(f[f.length - 1]) }))
    .filter((x) => Number.isFinite(x.r))
    .sort((a, b) => a.t - b.t);

  // Metrics: create_time, symbol, sum_open_interest, sum_open_interest_value, count_toptrader_long_short_ratio,
  // sum_toptrader_long_short_ratio, count_long_short_ratio, sum_taker_long_short_vol_ratio
  // Without a listing, the contract's life is taken from its funding payments.
  const first = funding.length ? Math.max(FROM, Math.floor(funding[0].t / DAY) * DAY) : FROM;
  const last = funding.length ? Math.min(now - DAY, funding[funding.length - 1].t + 31 * DAY) : now - DAY;
  const mPrefix = `data/futures/um/daily/metrics/${perp}/`;
  const days: string[] = [];
  for (let t = first; t <= last; t += DAY) days.push(`${mPrefix}${perp}-metrics-${ymd(t)}.zip`);
  const samples = (await fetchAll(await keysFor(mPrefix, dayOf, () => days)))
    .flatMap((csv) => csv.split("\n").map((l) => l.trim().split(",")).filter((f) => f.length >= 8 && /^\d{4}-/.test(f[0])))
    .map((f) => ({ t: toMs(f[0]), oi: +f[2], oiv: +f[3], topAcc: +f[4], topPos: +f[5], global: +f[6], taker: +f[7] }))
    .sort((a, b) => a.t - b.t);
  const bars: FuturesSeries["bars"] = { t: [], oi: [], oiv: [], topAcc: [], topPos: [], global: [], taker: [] };
  let takerSum = 0;
  let takerN = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const bucket = Math.floor(x.t / H4) * H4;
    if (Number.isFinite(x.taker) && x.taker > 0) {
      takerSum += x.taker;
      takerN++;
    }
    const next = samples[i + 1];
    if (next && Math.floor(next.t / H4) * H4 === bucket) continue;
    // The last snapshot of the bar: taken before the bar closed (a snapshot at the close itself belongs to the next bar).
    bars.t.push(bucket / 1000);
    bars.oi.push(x.oi);
    bars.oiv.push(x.oiv);
    bars.topAcc.push(x.topAcc);
    bars.topPos.push(x.topPos);
    bars.global.push(x.global);
    bars.taker.push(takerN ? takerSum / takerN : Number.NaN);
    takerSum = 0;
    takerN = 0;
  }

  // Perp klines (4h): open time, open, high, low, close, …
  const kPrefix = `data/futures/um/monthly/klines/${perp}/4h/`;
  const klineRows = (await fetchAll(await keysFor(kPrefix, monthOf, () => months(first, last).map((m) => `${kPrefix}${perp}-4h-${m}.zip`)))).flatMap(csvRows);
  const kl = klineRows.map((f) => ({ t: Math.floor(toMs(f[0]) / 1000), close: +f[4] })).sort((a, b) => a.t - b.t);
  const klines = { t: kl.map((k) => k.t), close: kl.map((k) => k.close) };
  return { perp, mult, funding, bars, klines };
}

/** Cached futures series of a spot symbol (null: no perpetual). */
export async function loadFutures(spot: string): Promise<FuturesSeries | null> {
  const file = path.join(DIR, `${spot}.json`);
  if (fs.existsSync(file)) {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v.none ? null : v;
  }
  const map = await perpFor(spot);
  fs.mkdirSync(DIR, { recursive: true });
  if (!map) {
    fs.writeFileSync(file, JSON.stringify({ none: true }));
    return null;
  }
  const series = await build(map.perp, map.mult);
  fs.writeFileSync(file, JSON.stringify(series));
  return series;
}

/** Read-only: the cached series, without downloading. */
export function cachedFutures(spot: string): FuturesSeries | null {
  const file = path.join(DIR, `${spot}.json`);
  if (!fs.existsSync(file)) return null;
  const v = JSON.parse(fs.readFileSync(file, "utf8"));
  return v.none ? null : v;
}

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  let done = 0;
  let withPerp = 0;
  let next = 0;
  const failed: string[] = [];
  await Promise.all(
    Array.from({ length: Number(process.env.FUTURES_SYMBOLS ?? 4) }, async () => {
      while (next < symbols.length) {
        const symbol = symbols[next++];
        try {
          if (await loadFutures(symbol)) withPerp++;
        } catch (err) {
          failed.push(`${symbol}: ${(err as Error).message}`);
        }
        if (++done % 20 === 0) console.log(`futures: ${done}/${symbols.length} (${withPerp} with a perpetual)`);
      }
    }),
  );
  console.log(`futures: done ${done - failed.length}/${symbols.length}, ${withPerp} with a perpetual${failed.length ? `, failed (re-run to retry):\n${failed.join("\n")}` : ""}`);
}

if (process.argv[1]?.endsWith("futures.ts")) void main();
