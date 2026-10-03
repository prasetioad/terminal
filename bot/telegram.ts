import type { BotEngine, Notifier } from "./engine";

/**
 * Telegram: notifications, and a few commands from the configured chat only.
 *   /status · /positions · /pause · /resume · /flatten CONFIRM · /help
 * Without TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID the bot just logs (ConsoleNotifier).
 */

export class ConsoleNotifier implements Notifier {
  async send(text: string): Promise<void> {
    console.log(`[notify] ${text.replace(/<[^>]+>/g, "")}`);
  }
}

export class TelegramNotifier implements Notifier {
  private readonly api: string;

  constructor(
    token: string,
    private readonly chatId: string,
  ) {
    this.api = `https://api.telegram.org/bot${token}`;
  }

  async send(text: string): Promise<void> {
    const res = await fetch(`${this.api}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}: ${await res.text()}`);
  }

  /** Long-poll commands until `signal` aborts. */
  async listen(engine: BotEngine, statusText: () => Promise<string>, signal: AbortSignal): Promise<void> {
    let offset = Number(engine.store.get("telegram_offset") ?? 0);
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.api}/getUpdates?timeout=25&offset=${offset}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) });
        const body = (await res.json()) as { result?: { update_id: number; message?: { chat: { id: number }; text?: string } }[] };
        for (const u of body.result ?? []) {
          offset = u.update_id + 1;
          engine.store.set("telegram_offset", String(offset));
          const msg = u.message;
          if (!msg?.text || String(msg.chat.id) !== this.chatId) continue; // only the owner's chat
          await this.handle(engine, msg.text.trim(), statusText);
        }
      } catch {
        if (!signal.aborted) await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handle(engine: BotEngine, text: string, statusText: () => Promise<string>): Promise<void> {
    const [cmd, arg] = text.split(/\s+/);
    switch (cmd.toLowerCase().replace(/@.*$/, "")) {
      case "/status":
        return this.send(await statusText());
      case "/positions": {
        const open = engine.store.openPositions();
        return this.send(open.length ? open.map((p) => `${p.symbol} @ ${p.entryPrice.toPrecision(6)} · stop ${p.stopPrice.toPrecision(6)} · ${p.cost.toFixed(2)} USDT`).join("\n") : "No open positions");
      }
      case "/pause":
        engine.risk.setPaused(true, "telegram /pause");
        return this.send("⏸ New entries paused. Open positions are still managed. /resume to continue.");
      case "/resume":
        engine.risk.setPaused(false, "telegram /resume");
        return this.send("▶️ New entries resumed.");
      case "/flatten":
        if (arg !== "CONFIRM") return this.send("This sells every open position at market and pauses entries. Send: /flatten CONFIRM");
        await engine.flatten("telegram /flatten");
        return;
      default:
        return this.send("Commands: /status · /positions · /pause · /resume · /flatten CONFIRM");
    }
  }
}
