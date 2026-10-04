import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { SetupId } from "./config";

/**
 * The bot's state: positions, an event log and equity snapshots, in SQLite. Schema
 * changes are append-only migrations, applied in order on open (like the heatmap DB).
 */

export type PositionStatus = "open" | "closed";
/** signal: v1 first red dot · trail: Setup A chandelier · stop: the resting stop. */
export type ExitReason = "signal" | "trail" | "stop" | "manual" | "flatten";

export interface Position {
  id: number;
  /** Which setup opened it (one position per pair across setups). */
  setup: SetupId;
  symbol: string;
  /** Bar the setup entered on (ms) — with the symbol, the idempotency key of an entry. */
  signalTime: number;
  status: PositionStatus;
  qty: number;
  entryPrice: number;
  entryFee: number; // USDT, informational (already inside `cost`)
  /** USDT that left the account for the entry, fees included. */
  cost: number;
  stopPrice: number;
  stopOrderId: string | null;
  openedAt: number;
  exitPrice: number | null;
  exitFee: number | null;
  /** USDT that came back from the exit, fees deducted. */
  proceeds: number | null;
  exitReason: ExitReason | null;
  closedAt: number | null;
  /** proceeds − cost: the net result in USDT, from actual cash flows (null while open). */
  pnl: number | null;
}

export interface EventRow {
  id: number;
  time: number;
  level: "info" | "warn" | "error";
  kind: string;
  message: string;
}

const MIGRATIONS: readonly string[] = [
  // v1
  `CREATE TABLE positions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     symbol TEXT NOT NULL,
     signal_time INTEGER NOT NULL,
     status TEXT NOT NULL,
     qty REAL NOT NULL,
     entry_price REAL NOT NULL,
     entry_fee REAL NOT NULL,
     cost REAL NOT NULL,
     stop_price REAL NOT NULL,
     stop_order_id TEXT,
     opened_at INTEGER NOT NULL,
     exit_price REAL,
     exit_fee REAL,
     proceeds REAL,
     exit_reason TEXT,
     closed_at INTEGER,
     pnl REAL,
     UNIQUE (symbol, signal_time)
   );
   CREATE INDEX positions_status ON positions (status);
   CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
   CREATE TABLE equity (time INTEGER PRIMARY KEY, equity REAL NOT NULL, cash REAL NOT NULL, open_positions INTEGER NOT NULL);
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v2: several setups on one account
  `ALTER TABLE positions ADD COLUMN setup TEXT NOT NULL DEFAULT 'v1';`,
];

const toPosition = (r: Record<string, unknown>): Position => ({
  id: r.id as number,
  setup: r.setup as SetupId,
  symbol: r.symbol as string,
  signalTime: r.signal_time as number,
  status: r.status as PositionStatus,
  qty: r.qty as number,
  entryPrice: r.entry_price as number,
  entryFee: r.entry_fee as number,
  cost: r.cost as number,
  stopPrice: r.stop_price as number,
  stopOrderId: (r.stop_order_id as string | null) ?? null,
  openedAt: r.opened_at as number,
  exitPrice: (r.exit_price as number | null) ?? null,
  exitFee: (r.exit_fee as number | null) ?? null,
  proceeds: (r.proceeds as number | null) ?? null,
  exitReason: (r.exit_reason as ExitReason | null) ?? null,
  closedAt: (r.closed_at as number | null) ?? null,
  pnl: (r.pnl as number | null) ?? null,
});

export class BotStore {
  private readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  /* ─────────────── positions ─────────────── */

  openPositions(): Position[] {
    return this.db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at").all().map((r) => toPosition(r as Record<string, unknown>));
  }

  closedPositions(limit = 500): Position[] {
    return this.db.prepare("SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?").all(limit).map((r) => toPosition(r as Record<string, unknown>));
  }

  /** Whether this signal was already acted on (an entry is never repeated). */
  hasSignal(symbol: string, signalTime: number): boolean {
    return this.db.prepare("SELECT 1 FROM positions WHERE symbol = ? AND signal_time = ?").get(symbol, signalTime) !== undefined;
  }

  insertPosition(p: Omit<Position, "id" | "status" | "exitPrice" | "exitFee" | "proceeds" | "exitReason" | "closedAt" | "pnl">): Position {
    const info = this.db
      .prepare(
        `INSERT INTO positions (setup, symbol, signal_time, status, qty, entry_price, entry_fee, cost, stop_price, stop_order_id, opened_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.setup, p.symbol, p.signalTime, p.qty, p.entryPrice, p.entryFee, p.cost, p.stopPrice, p.stopOrderId, p.openedAt);
    return toPosition(this.db.prepare("SELECT * FROM positions WHERE id = ?").get(info.lastInsertRowid) as Record<string, unknown>);
  }

  setStopOrder(id: number, stopOrderId: string | null): void {
    this.db.prepare("UPDATE positions SET stop_order_id = ? WHERE id = ?").run(stopOrderId, id);
  }

  closePosition(id: number, exit: { price: number; fee: number; proceeds: number; reason: ExitReason; time: number }): Position {
    const p = toPosition(this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as Record<string, unknown>);
    const pnl = exit.proceeds - p.cost;
    this.db
      .prepare("UPDATE positions SET status = 'closed', exit_price = ?, exit_fee = ?, proceeds = ?, exit_reason = ?, closed_at = ?, pnl = ? WHERE id = ?")
      .run(exit.price, exit.fee, exit.proceeds, exit.reason, exit.time, pnl, id);
    return { ...p, status: "closed", exitPrice: exit.price, exitFee: exit.fee, proceeds: exit.proceeds, exitReason: exit.reason, closedAt: exit.time, pnl };
  }

  /* ─────────────── events, equity, kv ─────────────── */

  log(level: EventRow["level"], kind: string, message: string, time = Date.now()): void {
    this.db.prepare("INSERT INTO events (time, level, kind, message) VALUES (?, ?, ?, ?)").run(time, level, kind, message);
  }

  events(limit = 200): EventRow[] {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as EventRow[];
  }

  recordEquity(time: number, equity: number, cash: number, openPositions: number): void {
    this.db.prepare("INSERT OR REPLACE INTO equity (time, equity, cash, open_positions) VALUES (?, ?, ?, ?)").run(time, equity, cash, openPositions);
  }

  equityCurve(limit = 5000): { time: number; equity: number; cash: number; openPositions: number }[] {
    return (this.db.prepare("SELECT time, equity, cash, open_positions FROM equity ORDER BY time DESC LIMIT ?").all(limit) as Record<string, number>[])
      .map((r) => ({ time: r.time, equity: r.equity, cash: r.cash, openPositions: r.open_positions }))
      .reverse();
  }

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }
}
