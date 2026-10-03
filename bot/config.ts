import { SETUP_V1, type StochPreset } from "../lib/setups/setupV1";

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
  stoch: StochPreset;
  /** Fraction of equity lost if the −15% stop is hit (sizes every position). */
  riskPerTrade: number;
  /** Cap on a single position, as a fraction of equity. */
  maxPositionFraction: number;
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

  const config: BotConfig = {
    mode,
    stoch,
    riskPerTrade: num(env, "RISK_PER_TRADE", 0.01, 0.0005, 0.05),
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
