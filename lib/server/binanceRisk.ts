/**
 * Binance's own warnings about a pair, for the bot and the scanner:
 *
 *   delist      spot pairs scheduled for removal — from the official delist schedule
 *               (/sapi/v1/spot/delist-schedule, needs an API key), else from the "Binance
 *               Will Delist A, B on YYYY-MM-DD" announcements (token delistings only; a single
 *               pair's removal is only in the schedule)
 *   monitoring  pairs with Binance's Monitoring tag (higher risk of a future delisting)
 *
 * Refreshed at most hourly; a failed refresh keeps the last good list, and an empty list
 * never blocks trading (fail open, logged by the caller).
 */

export interface RiskList {
  /** Symbol → delisting time (ms). */
  delist: Map<string, number>;
  monitoring: Set<string>;
  fetchedAt: number;
  source: { delist: "schedule" | "announcements" | "none"; monitoring: boolean };
}

export const EMPTY_RISK: RiskList = { delist: new Map(), monitoring: new Set(), fetchedAt: 0, source: { delist: "none", monitoring: false } };

const TTL_MS = 60 * 60_000;
const DAY = 86_400_000;
const PRODUCTS = "https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=false";
const ANNOUNCEMENTS = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=161&pageNo=1&pageSize=50";
const SCHEDULE = "https://api.binance.com/sapi/v1/spot/delist-schedule";

const getJson = async <T>(url: string, headers?: Record<string, string>): Promise<T> => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split("?")[0]}`);
  return (await res.json()) as T;
};

async function monitoringTags(): Promise<Set<string>> {
  const body = await getJson<{ data?: { s: string; tags?: string[] }[] }>(PRODUCTS);
  if (!body.data?.length) throw new Error("no products");
  return new Set(body.data.filter((p) => p.tags?.includes("Monitoring")).map((p) => p.s));
}

async function delistSchedule(apiKey: string): Promise<Map<string, number>> {
  const rows = await getJson<{ delistTime: number; symbols: string[] }[]>(SCHEDULE, { "X-MBX-APIKEY": apiKey });
  if (!Array.isArray(rows)) throw new Error("unexpected delist schedule");
  const out = new Map<string, number>();
  for (const r of rows) for (const s of r.symbols) out.set(s, r.delistTime);
  return out;
}

/** "Binance Will Delist ICX, SCRT, STORJ on 2026-09-03" → ICXUSDT, … at 03:00 UTC (Binance's usual time). */
export function parseDelistTitles(articles: { title: string; releaseDate: number }[], now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of articles) {
    const m = a.title.match(/^Binance Will Delist (.+?) on (\d{4})-(\d{2})-(\d{2})/i);
    if (!m || now - a.releaseDate > 60 * DAY) continue;
    const when = Date.UTC(+m[2], +m[3] - 1, +m[4], 3);
    if (when < now - DAY) continue;
    for (const token of m[1].split(/,|\band\b/).map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z0-9]+$/.test(t))) out.set(`${token}USDT`, when);
  }
  return out;
}

async function delistAnnouncements(now: number): Promise<Map<string, number>> {
  const body = await getJson<{ data?: { catalogs?: { articles: { title: string; releaseDate: number }[] }[] } }>(ANNOUNCEMENTS);
  const articles = body.data?.catalogs?.[0]?.articles;
  if (!articles) throw new Error("no announcements");
  return parseDelistTitles(articles, now);
}

let cache: { key: string; value: RiskList } | null = null;

/** The current lists (cached for an hour). `apiKey` (a live key) enables the official delist schedule. */
export async function fetchRiskList(apiKey?: string | null, now = Date.now()): Promise<RiskList> {
  const key = apiKey ? "key" : "public";
  if (cache && cache.key === key && now - cache.value.fetchedAt < TTL_MS) return cache.value;
  const previous = cache?.key === key ? cache.value : EMPTY_RISK;
  const [monitoring, delist] = await Promise.all([
    monitoringTags().then((m) => ({ ok: true as const, m })).catch(() => ({ ok: false as const, m: previous.monitoring })),
    (async () => {
      if (apiKey) {
        try {
          return { d: await delistSchedule(apiKey), source: "schedule" as const };
        } catch {
          // a testnet key, or the endpoint unreachable: the announcements below
        }
      }
      try {
        return { d: await delistAnnouncements(now), source: "announcements" as const };
      } catch {
        return { d: previous.delist, source: previous.source.delist };
      }
    })(),
  ]);
  const value: RiskList = { delist: delist.d, monitoring: monitoring.m, fetchedAt: now, source: { delist: delist.source, monitoring: monitoring.ok || previous.source.monitoring } };
  cache = { key, value };
  return value;
}
