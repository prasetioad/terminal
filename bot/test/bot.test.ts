/**
 * Bot unit tests:  npm run bot:test
 * Exchange calls are mocked; nothing here touches Binance.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSetupV1 } from "../../lib/setups/setupV1";
import type { Candle } from "../../lib/types";
import { BinanceApiError, BinanceSpotBroker, BinanceSpotClient, floorToStep, sign } from "../binance";
import { PaperBroker, type Broker, type Fill } from "../broker";
import { LIVE_CONFIRM_PHRASE, loadConfig } from "../config";
import { BotStore } from "../db";
import { BotEngine } from "../engine";
import { BAR_MS } from "../market";
import { ReplayMarketData } from "../replay";
import { RiskGate, sizePosition } from "../risk";

describe("binance primitives", () => {
  it("signs exactly like the Binance API documentation example", () => {
    const query = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    assert.equal(sign(query, secret), "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });

  it("floors to the step as an exact decimal string", () => {
    assert.equal(floorToStep(0.1234567, "0.001"), "0.123");
    assert.equal(floorToStep(12.9999999, "0.01"), "12.99");
    assert.equal(floorToStep(0.3, "0.1"), "0.3"); // float noise (0.1 + 0.2) must not floor to 0.2
    assert.equal(floorToStep(1234.5, "1"), "1234");
    assert.equal(floorToStep(0.000123456, "0.00000100"), "0.000123");
  });
});

describe("config", () => {
  it("defaults to paper", () => assert.equal(loadConfig({}).mode, "paper"));
  it("refuses live without the confirmation phrase", () => {
    assert.throws(() => loadConfig({ MODE: "live", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }), /LIVE_CONFIRM/);
    assert.throws(() => loadConfig({ MODE: "live", LIVE_CONFIRM: "yes", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }), /LIVE_CONFIRM/);
    assert.equal(loadConfig({ MODE: "live", LIVE_CONFIRM: LIVE_CONFIRM_PHRASE, BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }).mode, "live");
  });
  it("needs API keys outside paper", () => assert.throws(() => loadConfig({ MODE: "testnet" }), /BINANCE_API_KEY/));
  it("rejects out-of-range risk", () => assert.throws(() => loadConfig({ RISK_PER_TRADE: "0.5" }), /RISK_PER_TRADE/));
});

describe("risk", () => {
  const cfg = loadConfig({});
  it("sizes 1% risk at a −15% stop to 6.67% of equity", () => {
    const d = sizePosition(cfg, { equity: 10_000, cash: 10_000, openPositions: 0, minNotional: 5 });
    assert.ok(d.ok && Math.abs(d.quote - 666.67) < 0.01);
  });
  it("caps by free cash and by position count", () => {
    const d = sizePosition(cfg, { equity: 10_000, cash: 100, openPositions: 0, minNotional: 5 });
    assert.ok(d.ok && Math.abs(d.quote - 98) < 1e-9);
    assert.equal(sizePosition(cfg, { equity: 10_000, cash: 10_000, openPositions: 15, minNotional: 5 }).ok, false);
    assert.equal(sizePosition(cfg, { equity: 100, cash: 100, openPositions: 0, minNotional: 10 }).ok, false); // 6.67 < 15
  });
  it("blocks entries past the daily loss limit, and when paused", () => {
    const store = new BotStore(":memory:");
    const gate = new RiskGate(cfg, store);
    const t = Date.UTC(2026, 0, 5, 1);
    assert.equal(gate.entryBlock(10_000, t), null); // records the day's start
    assert.equal(gate.entryBlock(9_600, t + 3_600_000), null);
    assert.match(gate.entryBlock(9_400, t + 7_200_000) ?? "", /daily loss/);
    assert.equal(gate.entryBlock(9_400, t + 86_400_000), null); // a new day resets
    gate.setPaused(true, "test");
    assert.equal(gate.entryBlock(20_000, t + 86_400_000), "paused");
  });
});

describe("store and paper broker", () => {
  it("never records the same signal twice", () => {
    const store = new BotStore(":memory:");
    const p = { symbol: "BTCUSDT", signalTime: 1, qty: 1, entryPrice: 100, entryFee: 0.1, cost: 100, stopPrice: 85, stopOrderId: null, openedAt: 1 };
    store.insertPosition(p);
    assert.equal(store.hasSignal("BTCUSDT", 1), true);
    assert.throws(() => store.insertPosition(p), /UNIQUE/);
  });

  it("books P&L from cash flows: a round trip at one price loses exactly fees and slippage", async () => {
    const store = new BotStore(":memory:");
    const broker = new PaperBroker(store, 1000, 0.001, 0.0005);
    const buy = await broker.buy("X", 100, 10, "e");
    const pos = store.insertPosition({ symbol: "X", signalTime: 1, qty: buy.qty, entryPrice: buy.price, entryFee: buy.fee, cost: buy.quote, stopPrice: 8.5, stopOrderId: null, openedAt: 1 });
    const sell = await broker.sell("X", pos.qty, 10, "x");
    const done = store.closePosition(pos.id, { price: sell.price, fee: sell.fee, proceeds: sell.quote, reason: "signal", time: 2 });
    const expected = 100 * (1 - 0.001) / (10 * 1.0005) * 10 * 0.9995 * (1 - 0.001) - 100;
    assert.ok(Math.abs(done.pnl! - expected) < 1e-9);
    assert.ok(Math.abs((await broker.cash()) - (1000 + expected)) < 1e-9); // cash agrees with the books
  });
});

/* ───────────────────────────── Binance broker (mocked HTTP) ───────────────────────────── */

type Route = (url: URL, method: string) => { status: number; body: unknown } | "network-error";

function mockFetch(route: Route, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname} ${url.searchParams.get("type") ?? ""}`.trim());
    const r = route(url, method);
    if (r === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

const exchangeInfo = (orderTypes: string[]) => ({
  symbols: [
    {
      symbol: "SOLUSDT",
      status: "TRADING",
      baseAsset: "SOL",
      quoteAsset: "USDT",
      orderTypes,
      isSpotTradingAllowed: true,
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01000000" },
        { filterType: "LOT_SIZE", stepSize: "0.00100000", minQty: "0.00100000" },
        { filterType: "NOTIONAL", minNotional: "5.00000000" },
      ],
    },
  ],
});

describe("binance broker", () => {
  it("does not buy twice when the order request dies in flight", async () => {
    const calls: string[] = [];
    let posts = 0;
    const order = { orderId: 42, clientOrderId: "sv1-x-e", status: "FILLED", executedQty: "2.000", cummulativeQuoteQty: "300.00", fills: [{ price: "150", qty: "2", commission: "0.002", commissionAsset: "SOL" }] };
    const fetchImpl = mockFetch((url, method) => {
      if (url.pathname === "/api/v3/time") return { status: 200, body: { serverTime: Date.now() } };
      if (url.pathname === "/api/v3/exchangeInfo") return { status: 200, body: exchangeInfo(["MARKET", "STOP_LOSS_LIMIT"]) };
      if (url.pathname === "/api/v3/order" && method === "POST") return posts++ === 0 ? "network-error" : { status: 200, body: order };
      if (url.pathname === "/api/v3/order" && method === "GET") return { status: 200, body: order }; // it went through
      return { status: 404, body: {} };
    }, calls);
    const broker = new BinanceSpotBroker("testnet", new BinanceSpotClient("https://testnet.example", "k", "s", fetchImpl));
    const fill = await broker.buy("SOLUSDT", 300, 150, "sv1-x-e");
    assert.equal(posts, 1, "exactly one order request");
    assert.ok(calls.includes("GET /api/v3/order"), "looked the order up by client id");
    // The SOL commission reduces the holding; cost is what left the account.
    assert.ok(Math.abs(fill.qty - 1.998) < 1e-12);
    assert.ok(Math.abs(fill.quote - 300) < 1e-9);
    assert.ok(Math.abs(fill.fee - 0.3) < 1e-9);
  });

  it("does not retry an order the exchange rejected", async () => {
    let posts = 0;
    const fetchImpl = mockFetch((url, method) => {
      if (url.pathname === "/api/v3/time") return { status: 200, body: { serverTime: Date.now() } };
      if (url.pathname === "/api/v3/order" && method === "POST") return (posts++, { status: 400, body: { code: -2010, msg: "Account has insufficient balance" } });
      return { status: 404, body: {} };
    }, []);
    const broker = new BinanceSpotBroker("testnet", new BinanceSpotClient("https://t", "k", "s", fetchImpl));
    await assert.rejects(broker.buy("SOLUSDT", 300, 150, "c"), (e) => e instanceof BinanceApiError && e.code === -2010);
    assert.equal(posts, 1);
  });

  it("uses a stop-market when allowed, else a stop-limit 2% under, rounded to tick and step", async () => {
    for (const [types, expected] of [[["MARKET", "STOP_LOSS", "STOP_LOSS_LIMIT"], "STOP_LOSS"], [["MARKET", "STOP_LOSS_LIMIT"], "STOP_LOSS_LIMIT"]] as const) {
      let sent: URLSearchParams | null = null;
      const fetchImpl = mockFetch((url, method) => {
        if (url.pathname === "/api/v3/time") return { status: 200, body: { serverTime: Date.now() } };
        if (url.pathname === "/api/v3/exchangeInfo") return { status: 200, body: exchangeInfo([...types]) };
        if (url.pathname === "/api/v3/order" && method === "POST") return (sent = url.searchParams, { status: 200, body: { orderId: 7, status: "NEW", executedQty: "0", cummulativeQuoteQty: "0" } });
        return { status: 404, body: {} };
      }, []);
      const broker = new BinanceSpotBroker("testnet", new BinanceSpotClient("https://t", "k", "s", fetchImpl));
      assert.equal(await broker.placeStop("SOLUSDT", 1.99876, 127.123456, "s"), "7");
      const p = sent! as URLSearchParams;
      assert.equal(p.get("type"), expected);
      assert.equal(p.get("quantity"), "1.998");
      assert.equal(p.get("stopPrice"), "127.12");
      if (expected === "STOP_LOSS_LIMIT") assert.equal(p.get("price"), "124.58");
    }
  });

  it("treats cancelling an already-gone order as done", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.pathname === "/api/v3/time") return { status: 200, body: { serverTime: Date.now() } };
      return { status: 400, body: { code: -2011, msg: "Unknown order sent." } };
    }, []);
    const broker = new BinanceSpotBroker("testnet", new BinanceSpotClient("https://t", "k", "s", fetchImpl));
    await broker.cancelStop("SOLUSDT", "7");
  });
});

/* ───────────────────────────── engine safety ───────────────────────────── */

/** A random walk with enough swings to produce Setup v1 entries. */
function syntheticSeries(n: number, seed: number): Candle[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const start = Math.floor(Date.UTC(2025, 0, 1) / BAR_MS) * BAR_MS;
  let price = 100;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = price;
    price *= 1 + (rand() - 0.5) * 0.06 + Math.sin(i / 15) * 0.01;
    const high = Math.max(open, price) * (1 + rand() * 0.01);
    const low = Math.min(open, price) * (1 - rand() * 0.01);
    out.push({ time: ((start + i * BAR_MS) / 1000) as Candle["time"], open, high, low, close: price, volume: 1e6, buyVolume: 5e5 });
  }
  return out;
}

describe("engine", () => {
  const bars = syntheticSeries(1500, 7);
  const fresh = runSetupV1(bars, { stoch: "either", intervalMs: BAR_MS }).trades[0];
  const barTime = bars[fresh.entryIndex].time * 1000;
  const market = new ReplayMarketData(new Map([["TESTUSDT", bars]]));
  market.current = barTime;
  const cfg = { ...loadConfig({}), minLiquidity30d: 0, minBreadth: 1 };

  it("takes a fresh entry once, with its −15% stop", async () => {
    const store = new BotStore(":memory:");
    const engine = new BotEngine(cfg, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => barTime + BAR_MS);
    await engine.runCycle(barTime);
    await engine.runCycle(barTime); // a re-run (crash recovery) must not enter again
    const open = store.openPositions();
    assert.equal(open.length, 1);
    assert.equal(open[0].signalTime, fresh.entryTime);
    assert.ok(Math.abs(open[0].stopPrice / open[0].entryPrice - 0.85) < 1e-12);
  });

  it("never keeps a position whose stop could not be placed", async () => {
    const store = new BotStore(":memory:");
    const paper = new PaperBroker(store, 10_000, 0.001, 0);
    const sells: string[] = [];
    const broken: Broker = {
      kind: "testnet",
      cash: () => paper.cash(),
      holding: async () => 0,
      rules: async () => ({ ok: true, minNotional: 5 }),
      buy: (s, q, p, c) => paper.buy(s, q, p, c),
      sell: async (s, q, p, c): Promise<Fill> => (sells.push(c), paper.sell(s, q, p, c)),
      placeStop: async () => {
        throw new Error("stop rejected");
      },
      cancelStop: async () => {},
      stopFill: async () => null,
    };
    const engine = new BotEngine(cfg, store, market, broken, { send: async () => {} }, () => barTime + BAR_MS);
    const report = await engine.runCycle(barTime);
    assert.equal(store.openPositions().length, 0);
    assert.equal(sells.length, 1, "the entry was sold back");
    assert.match(report.errors.join(" "), /entry reversed/);
  });
});
