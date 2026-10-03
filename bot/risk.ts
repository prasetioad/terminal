import { SETUP_V1 } from "../lib/setups/setupV1";
import type { BotConfig } from "./config";
import type { BotStore } from "./db";

/**
 * Position sizing and the gates every new entry must pass. Exits are never blocked:
 * a paused or loss-limited bot still manages what it holds.
 */

export interface SizeInput {
  equity: number;
  cash: number;
  openPositions: number;
  minNotional: number;
}

export type SizeDecision = { ok: true; quote: number } | { ok: false; reason: string };

/**
 * Risk-based size: losing `riskPerTrade` of equity at the −15% stop → quote = equity ×
 * risk ÷ 15% (1% → 6.7% of equity), capped per position and by free cash.
 */
export function sizePosition(cfg: BotConfig, s: SizeInput): SizeDecision {
  if (s.openPositions >= cfg.maxOpenPositions) return { ok: false, reason: `max ${cfg.maxOpenPositions} open positions` };
  const byRisk = (s.equity * cfg.riskPerTrade) / SETUP_V1.stopPct;
  const quote = Math.min(byRisk, s.equity * cfg.maxPositionFraction, s.cash * 0.98);
  // Leave room above the exchange minimum so the stop (sold after fees) is still a valid order.
  if (quote < s.minNotional * 1.5) return { ok: false, reason: `size ${quote.toFixed(2)} USDT below the exchange minimum` };
  return { ok: true, quote };
}

const dayKey = (time: number) => `day_start_equity:${new Date(time).toISOString().slice(0, 10)}`;

export class RiskGate {
  constructor(
    private readonly cfg: BotConfig,
    private readonly store: BotStore,
  ) {}

  get paused(): boolean {
    return this.store.get("paused") === "1";
  }

  setPaused(paused: boolean, reason: string): void {
    this.store.set("paused", paused ? "1" : "0");
    this.store.log("warn", paused ? "pause" : "resume", reason);
  }

  /** Remember equity at the start of each UTC day; true while today's loss is within the limit. */
  withinDailyLoss(equity: number, now: number): boolean {
    const key = dayKey(now);
    const start = this.store.get(key);
    if (start === null) {
      this.store.set(key, String(equity));
      return true;
    }
    return equity >= Number(start) * (1 - this.cfg.dailyLossLimit);
  }

  /** Why new entries are blocked right now, if they are. */
  entryBlock(equity: number, now: number): string | null {
    if (this.paused) return "paused";
    if (!this.withinDailyLoss(equity, now)) return `daily loss limit (−${(this.cfg.dailyLossLimit * 100).toFixed(1)}%) reached`;
    return null;
  }
}
