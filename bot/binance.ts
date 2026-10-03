import { createHmac } from "node:crypto";
import type { Broker, Fill, TradeRules } from "./broker";

/**
 * Binance Spot: a signed REST client and the broker built on it.
 *
 * Safety rules, enforced here:
 *  - every order has a deterministic client id; when a request fails in flight, the
 *    order is looked up by that id before anything is retried (never a double buy);
 *  - quantities and prices are rounded to the symbol's step / tick as decimal strings;
 *  - the API key needs Spot trading only — never withdrawals (see docs/BOT.md).
 */

export const BINANCE_SPOT = {
  live: "https://api.binance.com",
  testnet: "https://testnet.binance.vision",
} as const;

const RECV_WINDOW = 5000;
const INFO_TTL_MS = 60 * 60_000;

export class BinanceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** HMAC-SHA256 signature of a query string, as Binance specifies. */
export const sign = (query: string, secret: string) => createHmac("sha256", secret).update(query).digest("hex");

/* ───────────────────────────── decimals ───────────────────────────── */

const decimalsOf = (step: string) => {
  const frac = step.includes(".") ? step.split(".")[1].replace(/0+$/, "") : "";
  return frac.length;
};

/** Round down to a multiple of `step` ("0.001"), returned as an exact decimal string. */
export function floorToStep(value: number, step: string): string {
  const d = decimalsOf(step);
  const scale = 10 ** d;
  const units = Math.round(Number(step) * scale);
  // A tiny epsilon absorbs float noise (0.3 / 0.1 = 2.9999…) without ever rounding a real value up.
  const v = Math.floor((value * scale) / units + 1e-9) * units;
  return (v / scale).toFixed(d);
}

/* ───────────────────────────── REST client ───────────────────────────── */

interface SymbolInfo {
  status: string;
  baseAsset: string;
  quoteAsset: string;
  orderTypes: string[];
  isSpotTradingAllowed: boolean;
  tickSize: string;
  stepSize: string;
  minQty: number;
  minNotional: number;
}

export class BinanceSpotClient {
  private offset = 0;
  private synced = 0;
  private info: { at: number; symbols: Map<string, SymbolInfo> } | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Keep request timestamps on the server's clock (Binance rejects drift > recvWindow). */
  private async syncTime(): Promise<void> {
    if (Date.now() - this.synced < 10 * 60_000) return;
    const before = Date.now();
    const { serverTime } = await this.request<{ serverTime: number }>("GET", "/api/v3/time", {}, false);
    this.offset = serverTime - Math.round((before + Date.now()) / 2);
    this.synced = Date.now();
  }

  async request<T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number>, signed: boolean): Promise<T> {
    if (signed) await this.syncTime();
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    if (signed) {
      query.set("recvWindow", String(RECV_WINDOW));
      query.set("timestamp", String(Date.now() + this.offset));
      query.set("signature", sign(query.toString(), this.apiSecret));
    }
    const url = `${this.baseUrl}${path}${query.size ? `?${query}` : ""}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: signed || method !== "GET" ? { "X-MBX-APIKEY": this.apiKey } : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let code: number | null = null;
      let msg = text;
      try {
        const body = JSON.parse(text) as { code?: number; msg?: string };
        code = body.code ?? null;
        msg = body.msg ?? text;
      } catch {}
      throw new BinanceApiError(res.status, code, `${method} ${path}: ${res.status} ${msg}`);
    }
    return JSON.parse(text) as T;
  }

  async symbolInfo(symbol: string): Promise<SymbolInfo | null> {
    if (!this.info || Date.now() - this.info.at > INFO_TTL_MS) {
      type Raw = { symbols: { symbol: string; status: string; baseAsset: string; quoteAsset: string; orderTypes: string[]; isSpotTradingAllowed: boolean; filters: Record<string, string>[] }[] };
      const raw = await this.request<Raw>("GET", "/api/v3/exchangeInfo", {}, false);
      const symbols = new Map<string, SymbolInfo>();
      for (const s of raw.symbols) {
        const f = (type: string) => s.filters.find((x) => x.filterType === type);
        const notional = f("NOTIONAL") ?? f("MIN_NOTIONAL");
        symbols.set(s.symbol, {
          status: s.status,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          orderTypes: s.orderTypes,
          isSpotTradingAllowed: s.isSpotTradingAllowed,
          tickSize: f("PRICE_FILTER")?.tickSize ?? "0.00000001",
          stepSize: f("LOT_SIZE")?.stepSize ?? "0.00000001",
          minQty: Number(f("LOT_SIZE")?.minQty ?? 0),
          minNotional: Number(notional?.minNotional ?? 5),
        });
      }
      this.info = { at: Date.now(), symbols };
    }
    return this.info.symbols.get(symbol) ?? null;
  }

  async balances(): Promise<Map<string, { free: number; locked: number }>> {
    const acc = await this.request<{ balances: { asset: string; free: string; locked: string }[] }>("GET", "/api/v3/account", { omitZeroBalances: "true" }, true);
    return new Map(acc.balances.map((b) => [b.asset, { free: Number(b.free), locked: Number(b.locked) }]));
  }
}

/* ───────────────────────────── broker ───────────────────────────── */

interface OrderResponse {
  orderId: number;
  clientOrderId: string;
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  fills?: { price: string; qty: string; commission: string; commissionAsset: string }[];
}

export class BinanceSpotBroker implements Broker {
  constructor(
    readonly kind: "testnet" | "live",
    private readonly client: BinanceSpotClient,
  ) {}

  async cash(): Promise<number> {
    return (await this.client.balances()).get("USDT")?.free ?? 0;
  }

  async holding(symbol: string): Promise<number> {
    const info = await this.client.symbolInfo(symbol);
    if (!info) return 0;
    const b = (await this.client.balances()).get(info.baseAsset);
    return b ? b.free + b.locked : 0;
  }

  async rules(symbol: string): Promise<TradeRules> {
    const info = await this.client.symbolInfo(symbol);
    if (!info) return { ok: false, reason: "not listed on this exchange", minNotional: 0 };
    if (info.status !== "TRADING" || !info.isSpotTradingAllowed) return { ok: false, reason: `status ${info.status}`, minNotional: info.minNotional };
    if (!info.orderTypes.includes("MARKET")) return { ok: false, reason: "no market orders", minNotional: info.minNotional };
    if (!info.orderTypes.includes("STOP_LOSS") && !info.orderTypes.includes("STOP_LOSS_LIMIT")) return { ok: false, reason: "no stop orders", minNotional: info.minNotional };
    return { ok: true, minNotional: info.minNotional };
  }

  /** Place an order, or — if the request died in flight — find the one it may have created. */
  private async order(symbol: string, params: Record<string, string>): Promise<OrderResponse> {
    const clientId = params.newClientOrderId;
    try {
      return await this.client.request<OrderResponse>("POST", "/api/v3/order", { symbol, newOrderRespType: "FULL", ...params }, true);
    } catch (err) {
      if (err instanceof BinanceApiError && err.status >= 400 && err.status < 500) throw err; // rejected: nothing was placed
      const existing = await this.client.request<OrderResponse>("GET", "/api/v3/order", { symbol, origClientOrderId: clientId }, true).catch(() => null);
      if (existing) return existing;
      throw err;
    }
  }

  /** USDT value of an order's commissions, and how much of the base asset they took. */
  private async fees(symbol: string, res: OrderResponse, price: number): Promise<{ usdt: number; base: number }> {
    const info = await this.client.symbolInfo(symbol);
    let usdt = 0;
    let base = 0;
    for (const f of res.fills ?? []) {
      const c = Number(f.commission);
      if (!c) continue;
      if (f.commissionAsset === info?.baseAsset) {
        base += c;
        usdt += c * price;
      } else if (f.commissionAsset === "USDT") usdt += c;
      else {
        const t = await this.client.request<{ price: string }>("GET", "/api/v3/ticker/price", { symbol: `${f.commissionAsset}USDT` }, false).catch(() => null);
        usdt += c * Number(t?.price ?? 0);
      }
    }
    return { usdt, base };
  }

  async buy(symbol: string, quote: number, _refPrice: number, clientId: string): Promise<Fill> {
    const res = await this.order(symbol, { side: "BUY", type: "MARKET", quoteOrderQty: floorToStep(quote, "0.01"), newClientOrderId: clientId });
    const qty = Number(res.executedQty);
    const spent = Number(res.cummulativeQuoteQty);
    if (!(qty > 0)) throw new Error(`buy ${symbol}: nothing filled (status ${res.status})`);
    const price = spent / qty;
    const fee = await this.fees(symbol, res, price);
    // A fee in the base asset reduces what we hold; one paid in USDT/BNB adds to what we spent.
    return { qty: qty - fee.base, price, fee: fee.usdt, quote: spent + (fee.usdt - fee.base * price), orderId: String(res.orderId) };
  }

  async sell(symbol: string, qty: number, _refPrice: number, clientId: string): Promise<Fill> {
    const info = await this.client.symbolInfo(symbol);
    if (!info) throw new Error(`sell ${symbol}: unknown symbol`);
    const quantity = floorToStep(qty, info.stepSize);
    const res = await this.order(symbol, { side: "SELL", type: "MARKET", quantity, newClientOrderId: clientId });
    const sold = Number(res.executedQty);
    const received = Number(res.cummulativeQuoteQty);
    const price = sold > 0 ? received / sold : 0;
    const fee = await this.fees(symbol, res, price);
    return { qty: sold, price, fee: fee.usdt, quote: received - fee.usdt, orderId: String(res.orderId) };
  }

  async placeStop(symbol: string, qty: number, stopPrice: number, clientId: string): Promise<string | null> {
    const info = await this.client.symbolInfo(symbol);
    if (!info) throw new Error(`stop ${symbol}: unknown symbol`);
    const quantity = floorToStep(qty, info.stepSize);
    const stop = floorToStep(stopPrice, info.tickSize);
    const params: Record<string, string> = info.orderTypes.includes("STOP_LOSS")
      ? { side: "SELL", type: "STOP_LOSS", quantity, stopPrice: stop, newClientOrderId: clientId }
      : // Stop-limit: a 2% buffer under the trigger so a fast drop still fills.
        { side: "SELL", type: "STOP_LOSS_LIMIT", timeInForce: "GTC", quantity, stopPrice: stop, price: floorToStep(stopPrice * 0.98, info.tickSize), newClientOrderId: clientId };
    const res = await this.order(symbol, params);
    return String(res.orderId);
  }

  async cancelStop(symbol: string, orderId: string): Promise<void> {
    try {
      await this.client.request("DELETE", "/api/v3/order", { symbol, orderId }, true);
    } catch (err) {
      if (err instanceof BinanceApiError && err.code === -2011) return; // already gone (filled or cancelled)
      throw err;
    }
  }

  async stopFill(symbol: string, orderId: string): Promise<Fill | null> {
    const o = await this.client.request<OrderResponse>("GET", "/api/v3/order", { symbol, orderId }, true);
    if (o.status !== "FILLED") return null;
    const trades = await this.client.request<{ price: string; qty: string; commission: string; commissionAsset: string }[]>("GET", "/api/v3/myTrades", { symbol, orderId }, true);
    const sold = Number(o.executedQty);
    const received = Number(o.cummulativeQuoteQty);
    const price = sold > 0 ? received / sold : 0;
    const fee = await this.fees(symbol, { ...o, fills: trades }, price);
    return { qty: sold, price, fee: fee.usdt, quote: received - fee.usdt, orderId };
  }
}
