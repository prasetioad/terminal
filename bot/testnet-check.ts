/**
 * Execution check against the Binance Spot TESTNET (play money), through the bot's own
 * broker: buy → stop on the exchange → stop not filled → cancel → sell → cancel again.
 *
 *   npx tsx bot/testnet-check.ts [SYMBOL] [USDT]       (keys from bot/.env)
 *
 * Refuses to run against anything but the testnet.
 */
import { loadEnvFile } from "node:process";
import { BINANCE_SPOT, BinanceSpotBroker, BinanceSpotClient } from "./binance";

try {
  loadEnvFile("bot/.env");
} catch {}

async function main() {
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!key || !secret) throw new Error("BINANCE_API_KEY / BINANCE_API_SECRET missing in bot/.env");
  const symbol = process.argv[2] ?? "BTCUSDT";
  const quote = Number(process.argv[3] ?? 15);
  const client = new BinanceSpotClient(BINANCE_SPOT.testnet, key, secret);
  const broker = new BinanceSpotBroker("testnet", client);
  const run = Date.now().toString(36);
  const step = (name: string, detail: unknown) => console.log(`✓ ${name.padEnd(28)} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);

  const rules = await broker.rules(symbol);
  if (!rules.ok) throw new Error(`${symbol} not tradable on testnet: ${rules.reason}`);
  step("rules", rules);
  const cashBefore = await broker.cash();
  const heldBefore = await broker.holding(symbol);
  step("USDT free before", cashBefore.toFixed(4));

  const buy = await broker.buy(symbol, quote, 0, `chk-${run}-e`);
  step("market buy", { qty: buy.qty, price: buy.price, feeUsdt: +buy.fee.toFixed(6), spent: +buy.quote.toFixed(6), orderId: buy.orderId });

  const stopId = await broker.placeStop(symbol, buy.qty, buy.price * 0.85, `chk-${run}-s`);
  if (!stopId) throw new Error("no stop order id");
  step("stop −15% resting", `orderId ${stopId}`);

  const filled = await broker.stopFill(symbol, stopId);
  if (filled) throw new Error("stop unexpectedly filled");
  step("stop not filled (as expected)", "ok");

  await broker.cancelStop(symbol, stopId);
  step("stop cancelled", "ok");

  const qty = Math.min(buy.qty, (await broker.holding(symbol)) - heldBefore);
  const sell = await broker.sell(symbol, qty, 0, `chk-${run}-x`);
  step("market sell", { qty: sell.qty, price: sell.price, feeUsdt: +sell.fee.toFixed(6), received: +sell.quote.toFixed(6) });

  await broker.cancelStop(symbol, stopId); // already gone: must not throw
  step("cancel again (already gone)", "ok, ignored");

  const cashAfter = await broker.cash();
  step("round-trip P&L (books)", `${(sell.quote - buy.quote).toFixed(6)} USDT`);
  step("USDT free after", `${cashAfter.toFixed(4)} (Δ ${(cashAfter - cashBefore).toFixed(6)})`);
  console.log("\nTESTNET EXECUTION CHECK PASSED");
}

main().catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
});
