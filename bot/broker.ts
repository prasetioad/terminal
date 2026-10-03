import type { BotStore } from "./db";

/**
 * How orders get done. PaperBroker simulates fills (fees and slippage included);
 * BinanceSpotBroker (bot/binance.ts) trades on Binance Spot — testnet or live.
 * Every order carries a deterministic client id so a retried request can't
 * create a second order.
 */
export interface Fill {
  qty: number; // base units received (buy, net of a base-asset fee) or sold
  price: number; // average fill price
  fee: number; // USDT value of the commission
  /** USDT that moved: spent on a buy (fees included), received from a sell (fees deducted). */
  quote: number;
  orderId: string;
}

export interface TradeRules {
  ok: boolean;
  reason?: string;
  /** Smallest order value the exchange accepts, USDT. */
  minNotional: number;
}

export interface Broker {
  readonly kind: "paper" | "testnet" | "live";
  /** Free USDT. */
  cash(): Promise<number>;
  /** Base units of the asset held (free + locked in orders). */
  holding(symbol: string): Promise<number>;
  rules(symbol: string): Promise<TradeRules>;
  /** Spend `quote` USDT at market. `refPrice` is the bar close (paper fills around it). */
  buy(symbol: string, quote: number, refPrice: number, clientId: string): Promise<Fill>;
  /** Sell `qty` at market. */
  sell(symbol: string, qty: number, refPrice: number, clientId: string): Promise<Fill>;
  /** Rest a stop order on the exchange; null when the bot watches the stop itself (paper). */
  placeStop(symbol: string, qty: number, stopPrice: number, clientId: string): Promise<string | null>;
  cancelStop(symbol: string, orderId: string): Promise<void>;
  /** Whether a resting stop has been filled (and how). */
  stopFill(symbol: string, orderId: string): Promise<Fill | null>;
}

/**
 * Simulated broker. Cash lives in the bot's store so restarts keep the account;
 * holdings are the open positions themselves.
 */
export class PaperBroker implements Broker {
  readonly kind = "paper" as const;

  constructor(
    private readonly store: BotStore,
    private readonly startEquity: number,
    private readonly feeRate: number,
    private readonly slippage: number,
  ) {
    if (store.get("paper_cash") === null) store.set("paper_cash", String(startEquity));
  }

  async cash(): Promise<number> {
    return Number(this.store.get("paper_cash"));
  }

  private setCash(v: number) {
    this.store.set("paper_cash", String(v));
  }

  async holding(symbol: string): Promise<number> {
    return this.store.openPositions().filter((p) => p.symbol === symbol).reduce((s, p) => s + p.qty, 0);
  }

  async rules(): Promise<TradeRules> {
    return { ok: true, minNotional: 5 };
  }

  async buy(_symbol: string, quote: number, refPrice: number, clientId: string): Promise<Fill> {
    const cash = await this.cash();
    if (quote > cash + 1e-9) throw new Error(`paper: not enough cash (${cash.toFixed(2)} < ${quote.toFixed(2)})`);
    const price = refPrice * (1 + this.slippage);
    const fee = quote * this.feeRate;
    this.setCash(cash - quote);
    return { qty: (quote - fee) / price, price, fee, quote, orderId: clientId };
  }

  async sell(_symbol: string, qty: number, refPrice: number, clientId: string): Promise<Fill> {
    const price = refPrice * (1 - this.slippage);
    const proceeds = qty * price;
    const fee = proceeds * this.feeRate;
    this.setCash((await this.cash()) + proceeds - fee);
    return { qty, price, fee, quote: proceeds - fee, orderId: clientId };
  }

  async placeStop(): Promise<string | null> {
    return null; // the engine fills paper stops from the bars, as the backtest does
  }

  async cancelStop(): Promise<void> {}

  async stopFill(): Promise<Fill | null> {
    return null;
  }
}
