/**
 * Research data: Binance spot klines from the public archive (data.binance.vision),
 * which keeps delisted symbols too — the basis for a survivorship-free universe —
 * topped up from the REST API for the current month. Cached under research/.cache.
 */
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Candle } from "../lib/types";

export const CACHE_DIR = path.join(import.meta.dirname, ".cache");
const ARCHIVE = "https://data.binance.vision";
const LISTING = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const API = "https://data-api.binance.vision";

/** A candle with its quote (USDT) volume, which the liquidity filter needs. */
export interface ResearchBar extends Candle {
  quoteVolume: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** At most this many archive downloads in flight across all symbols. */
const DOWNLOAD_SLOTS = 12;
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= DOWNLOAD_SLOTS) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

export async function fetchWithRetry(url: string, init?: RequestInit, attempts = 5): Promise<Response> {
  let last: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      if (res.ok || res.status === 404) return res;
      if (res.status === 429 || res.status === 418) await sleep((Number(res.headers.get("retry-after")) || 10) * 1000);
      last = new Error(`HTTP ${res.status} ${url}`);
    } catch (err) {
      last = err;
    }
    await sleep(1000 * (a + 1));
  }
  throw last;
}

/** Every key (or common prefix) under `prefix` in the archive bucket, following pagination. */
async function listBucket(prefix: string, delimiter: boolean): Promise<string[]> {
  const out: string[] = [];
  let marker = "";
  for (;;) {
    const url = `${LISTING}?prefix=${encodeURIComponent(prefix)}${delimiter ? "&delimiter=/" : ""}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
    const xml = await (await fetchWithRetry(url)).text();
    const tag = delimiter ? /<Prefix>([^<]+)<\/Prefix>/g : /<Key>([^<]+)<\/Key>/g;
    const found = [...xml.matchAll(tag)].map((m) => m[1]).filter((k) => k !== prefix);
    out.push(...found);
    if (!xml.includes("<IsTruncated>true</IsTruncated>")) break;
    marker = xml.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1] ?? found.at(-1) ?? "";
    if (!marker) break;
  }
  return out;
}

/** All spot symbols that have monthly klines in the archive (listed and delisted). */
export async function archiveSymbols(): Promise<string[]> {
  const file = path.join(CACHE_DIR, "archive-symbols.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const prefixes = await listBucket("data/spot/monthly/klines/", true);
  const symbols = prefixes.map((p) => p.split("/").at(-2)!).filter(Boolean);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(symbols));
  return symbols;
}

/** The single CSV inside a Binance archive zip (read through the central directory). */
function unzipSingle(buf: Buffer): string {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip");
  const central = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(central + 10);
  const compressed = buf.readUInt32LE(central + 20);
  const local = buf.readUInt32LE(central + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + compressed);
  return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
}

/** Archive timestamps switched from milliseconds to microseconds in 2025. */
const toMs = (t: number) => (t > 1e14 ? Math.floor(t / 1000) : t);

function parseRows(csv: string): ResearchBar[] {
  const out: ResearchBar[] = [];
  for (const line of csv.split("\n")) {
    const f = line.split(",");
    if (f.length < 11 || !/^\d/.test(f[0])) continue; // header or blank
    out.push({
      time: Math.floor(toMs(Number(f[0])) / 1000) as Candle["time"],
      open: +f[1],
      high: +f[2],
      low: +f[3],
      close: +f[4],
      volume: +f[5],
      quoteVolume: +f[7],
      buyVolume: +f[9],
    });
  }
  return out;
}

/**
 * Full history of `symbol` at `interval` since `fromYear`: archive months plus the
 * current month from the API (absent for delisted symbols). Cached per symbol.
 */
export async function loadSeries(symbol: string, interval: string, fromYear: number): Promise<ResearchBar[]> {
  const dir = path.join(CACHE_DIR, "klines", interval);
  const file = path.join(dir, `${symbol}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = (await listBucket(`data/spot/monthly/klines/${symbol}/${interval}/`, false)).filter((k) => {
    const m = k.match(/-(\d{4})-\d{2}\.zip$/);
    return m && Number(m[1]) >= fromYear;
  });
  // Every listed month must arrive: a partial or empty series is never cached.
  const months = await Promise.all(
    keys.map((key) =>
      slot(async () => {
        const res = await fetchWithRetry(`${ARCHIVE}/${key}`);
        if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
        const rows = parseRows(unzipSingle(Buffer.from(await res.arrayBuffer())));
        if (!rows.length) throw new Error(`${key}: no rows`);
        return rows;
      }),
    ),
  );
  const bars: ResearchBar[] = months.flat();
  // The archive lags by up to a month: top up from the API while the symbol still trades.
  const last = bars.at(-1)?.time ?? 0;
  if (keys.length > 0) {
    let start = (last + 1) * 1000;
    for (;;) {
      const res = await fetchWithRetry(`${API}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&limit=1000`);
      if (!res.ok) break; // delisted
      const rows = (await res.json()) as (string | number)[][];
      const closed = rows.filter((k) => Number(k[6]) < Date.now());
      bars.push(...closed.map((k) => ({ time: Math.floor(Number(k[0]) / 1000) as Candle["time"], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7], buyVolume: +k[9] })));
      if (rows.length < 1000) break;
      start = Number(rows.at(-1)![0]) + 1;
    }
  }
  bars.sort((a, b) => a.time - b.time);
  const unique = bars.filter((b, i) => i === 0 || b.time !== bars[i - 1].time);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(unique));
  return unique;
}

/**
 * Split a series where bars are missing for more than `maxGapMs` (a halt, a delisting,
 * or a ticker reused by a different coin, e.g. LUNA → LUNA 2.0): each piece is traded
 * as its own history.
 */
export function segments(bars: ResearchBar[], maxGapMs: number): ResearchBar[][] {
  const out: ResearchBar[][] = [];
  let current: ResearchBar[] = [];
  for (const b of bars) {
    const prev = current.at(-1);
    if (prev && (b.time - prev.time) * 1000 > maxGapMs) {
      out.push(current);
      current = [];
    }
    current.push(b);
  }
  if (current.length) out.push(current);
  return out;
}
