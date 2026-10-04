import { SETUP_V1, type StochPreset } from "../lib/setups/setupV1";

/** Strategies the bot can run side by side on one account: Setup v1 (capitulation) and Setup A (breakout). */
export type SetupId = "v1" | "a";

/**
 * Bot configuration, from the environment (see bot/.env.example).
 *
 * The bot starts in PAPER mode unless told otherwise. LIVE trading needs both
 * MODE=live and LIVE_CONFIRM set to the exact phrase below: a typo or a copied
 * testnet config can never put real money at risk.
 */

export type Mode = "paper" | "testnet" | "live";

type Env = Record<string, string | undefined>;

export const LIVE_CONFIRM_PHRASE = "I_UNDERSTAND_THIS_TRADES_REAL_MONEY";

export interface BotConfig {
  mode: Mode;
  /** Setups traded, sharing one account (docs/ROADMAP.md §4.10). */
  setups: SetupId[];
  stoch: StochPreset;
  /** Setup v1: fraction of equity lost if the −15% stop is hit (sizes every v1 position). */
  riskPerTrade: number;
  /** Setup v1.2: cap on the risk of all v1 entries taken on one bar (0 = off, v1.1). */
  maxRiskPerBar: number;
  /** Setup v1: skip a second green dot of the same drop (§4.12). */
  firstDotOnly: boolean;
  /** Setup A: fraction of equity lost at its 8×ATR stop. */
  riskPerTradeA: number;
  /** Setup A: open positions at most; at most 5 entries per bar (≤ 5 × its risk, as in the research). */
  maxOpenPositionsA: number;
  /** Setup A: take only coins whose 30-day return trails BTC's by more than this (e.g. −0.1); null = off (§4.12). */
  maxRsA: number | null;
  /** Setup A: tighten the chandelier to 4×ATR after a tall up-bar (≥ 3×ATR) in profit (§4.16). */
  spikeTightenA: boolean;
  /** Cap on a single position, as a fraction of equity. */
  maxPositionFraction: number;
  /** Setup v1: open positions at most. */
  maxOpenPositions: number;
  /** Setup v1.1: trade a bar only when at least this many pairs signal at once. */
  minBreadth: number;
  /** Setup v1.1: minimum trailing 30-day average daily quote volume (USDT) of a pair. */
  minLiquidity30d: number;
  /** New entries stop for the rest of the UTC day once equity is down this much since the day's start. */
  dailyLossLimit: number;
  /** Paper mode: starting equity in USDT, fee and slippage per side. */
  paperStartEquity: number;
  feeRate: number;
  slippage: number;
  binanceApiKey: string | null;
  binanceApiSecret: string | null;
  telegramToken: string | null;
  telegramChatId: string | null;
  apiPort: number;
  apiToken: string | null;
  dbPath: string;
}

const num = (env: Env, key: string, fallback: number, min: number, max: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${key} must be a number in [${min}, ${max}], got "${raw}"`);
  return v;
};

const bool = (env: Env, key: string, fallback: boolean): boolean => {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${key} must be 1/0 (true/false), got "${env[key]}"`);
};

const str = (env: Env, key: string): string | null => {
  const v = env[key]?.trim();
  return v ? v : null;
};

export function loadConfig(env: Env = process.env): BotConfig {
  const mode = (env.MODE ?? "paper").toLowerCase();
  if (mode !== "paper" && mode !== "testnet" && mode !== "live") throw new Error(`MODE must be paper, testnet or live, got "${env.MODE}"`);
  if (mode === "live" && env.LIVE_CONFIRM !== LIVE_CONFIRM_PHRASE) {
    throw new Error(`MODE=live requires LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE}`);
  }
  const stoch = env.STOCH ?? "either";
  if (stoch !== "either" && stoch !== "5,3,3" && stoch !== "14,3,3") throw new Error(`STOCH must be either, 5,3,3 or 14,3,3`);

  const setups = (env.SETUPS ?? "v1").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!setups.length || setups.some((x) => x !== "v1" && x !== "a") || new Set(setups).size !== setups.length) {
    throw new Error(`SETUPS must list v1 and/or a (e.g. "v1,a"), got "${env.SETUPS}"`);
  }

  const config: BotConfig = {
    mode,
    setups: setups as SetupId[],
    stoch,
    riskPerTrade: num(env, "RISK_PER_TRADE", 0.01, 0.0005, 0.05),
    maxRiskPerBar: num(env, "MAX_RISK_PER_BAR", 0, 0, 1),
    firstDotOnly: bool(env, "V1_FIRST_DOT_ONLY", false),
    riskPerTradeA: num(env, "RISK_PER_TRADE_A", 0.005, 0.0005, 0.05),
    maxOpenPositionsA: num(env, "MAX_OPEN_POSITIONS_A", 15, 1, 50),
    spikeTightenA: bool(env, "A_SPIKE_TIGHTEN", false),
    maxRsA: env.A_MAX_RS === undefined || env.A_MAX_RS.trim() === "" ? null : num(env, "A_MAX_RS", 0, -1, 1),
    maxPositionFraction: num(env, "MAX_POSITION_FRACTION", 0.1, 0.01, 0.5),
    maxOpenPositions: num(env, "MAX_OPEN_POSITIONS", 15, 1, 50),
    minBreadth: num(env, "MIN_BREADTH", SETUP_V1.minBreadth, 1, 500),
    minLiquidity30d: num(env, "MIN_LIQUIDITY_30D", SETUP_V1.minLiquidity30d, 0, 1e12),
    dailyLossLimit: num(env, "DAILY_LOSS_LIMIT", 0.05, 0.005, 0.5),
    paperStartEquity: num(env, "PAPER_START_EQUITY", 10_000, 10, 1e9),
    feeRate: num(env, "FEE_RATE", 0.001, 0, 0.01),
    slippage: num(env, "SLIPPAGE", 0.0005, 0, 0.02),
    binanceApiKey: str(env, "BINANCE_API_KEY"),
    binanceApiSecret: str(env, "BINANCE_API_SECRET"),
    telegramToken: str(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: str(env, "TELEGRAM_CHAT_ID"),
    apiPort: num(env, "API_PORT", 8787, 1, 65535),
    apiToken: str(env, "API_TOKEN"),
    dbPath: env.DB_PATH ?? "bot/data/bot.sqlite",
  };
  if (config.mode !== "paper" && (!config.binanceApiKey || !config.binanceApiSecret)) {
    throw new Error(`MODE=${config.mode} needs BINANCE_API_KEY and BINANCE_API_SECRET`);
  }
  return config;
}
