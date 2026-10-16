import { SETUP_V1 } from "../lib/setups/setupV1";
import type { BotConfig, SetupId } from "./config";
import type { BotStore } from "./db";

/**
 * Position sizing and the gates every new entry must pass. Exits are never blocked:
 * a paused or loss-limited bot still manages what it holds.
 */

export interface SizeInput {
  equity: number;
  cash: number;
  /** Open positions of this setup. */
  openPositions: number;
  minNotional: number;
  /** Default: Setup v1 with its −15% stop. */
  setup?: SetupId;
  /** Fraction lost at the stop (Setup A: 8×ATR ÷ entry). Default: Setup v1's 15%. */
  stopPct?: number;
  /** USDT value of one quantity step of the pair (step size × price); 0 when unknown (paper). */
  stepValue?: number;
}

/** Risk per trade and position count of a setup. */
export function setupRules(cfg: BotConfig, setup: SetupId): { risk: number; maxOpen: number } {
  if (setup === "a") return { risk: cfg.riskPerTradeA, maxOpen: cfg.maxOpenPositionsA };
  if (setup === "z") return { risk: cfg.riskPerTradeZ, maxOpen: cfg.maxOpenPositions };
  return { risk: cfg.riskPerTrade, maxOpen: cfg.maxOpenPositions };
}

export type SizeDecision = { ok: true; quote: number } | { ok: false; reason: string };

/**
 * Risk-based size: losing the setup's risk of equity at its stop → quote = equity × risk
 * ÷ stop distance (v1: 1% at −15% → 6.7% of equity), capped per position and by free cash.
 */
export function sizePosition(cfg: BotConfig, s: SizeInput): SizeDecision {
  const { risk, maxOpen } = setupRules(cfg, s.setup ?? "v1");
  const stopPct = s.stopPct ?? SETUP_V1.stopPct;
  if (s.openPositions >= maxOpen) return { ok: false, reason: `max ${maxOpen} open positions` };
  const byRisk = (s.equity * risk) / stopPct;
  const quote = Math.min(byRisk, s.equity * cfg.maxPositionFraction, s.cash * 0.98);
  // The stop, once hit, must still be a valid order. The buy and the stop are each floored to the
  // pair's quantity step, and a fee in the base asset leaves the holding just under a step: up to two
  // steps lost (NEAR Oct 2026: a $6.52 buy filled 1.2, the stop could only take 1.1 → $4.79 < $5).
  const minQuote = (s.minNotional * 1.1) / (1 - stopPct) + 2 * (s.stepValue ?? 0);
  if (quote >= minQuote) return { ok: true, quote };
  // Small accounts: the smallest valid size, if its loss at the stop stays within the cap.
  if (cfg.minSizeMaxRisk > 0 && minQuote * stopPct <= s.equity * cfg.minSizeMaxRisk && minQuote <= s.cash * 0.98 && minQuote <= s.equity * cfg.maxPositionFraction) {
    return { ok: true, quote: minQuote };
  }
  return { ok: false, reason: `size ${quote.toFixed(2)} USDT below the exchange minimum` };
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
    // A deposit today is not a gain, a withdrawal not a loss.
    const flows = this.store.netFlows(Math.floor(now / 86_400_000) * 86_400_000);
    return equity - flows >= Number(start) * (1 - this.cfg.dailyLossLimit);
  }

  /** Why new entries are blocked right now, if they are. */
  entryBlock(equity: number, now: number): string | null {
    if (this.paused) return "paused";
    if (!this.withinDailyLoss(equity, now)) return `daily loss limit (−${(this.cfg.dailyLossLimit * 100).toFixed(1)}%) reached`;
    return null;
  }
}
