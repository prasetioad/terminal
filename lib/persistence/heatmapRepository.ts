import type { HeatmapFrame } from "../heatmap/frame";
import { openDatabase, requestResult, transactionDone, type Migration } from "./idb";

/**
 * One minute of downsampled heatmap frames for one symbol. Self-describing (it carries
 * its bucket step), so chunks can be copied to any other store as they are.
 */
export interface HeatmapChunk {
  symbol: string;
  start: number; // ms, minute boundary
  end: number; // ms, exclusive
  step: number; // price bucket size the frames use
  frames: HeatmapFrame[];
}

/**
 * Storage for heatmap history. The engine only talks to this interface, so the
 * browser store below can be replaced by (or copied into) a server-side database
 * without touching the recording code — see `copyHistory`.
 */
export interface HeatmapRepository {
  getStep(symbol: string): Promise<number | null>;
  setStep(symbol: string, step: number): Promise<void>;
  /** Insert or replace a chunk (the current minute is rewritten while it fills). */
  putChunk(chunk: HeatmapChunk): Promise<void>;
  /** Chunks of `symbol` ending after `sinceMs`, oldest first. */
  chunks(symbol: string, sinceMs: number): Promise<HeatmapChunk[]>;
  symbols(): Promise<string[]>;
  /** Delete chunks that ended before `beforeMs`; returns how many were removed. */
  prune(beforeMs: number): Promise<number>;
}

/** Copy all history from one repository to another (e.g. browser → server). Returns chunks copied. */
export async function copyHistory(from: HeatmapRepository, to: HeatmapRepository, sinceMs = 0): Promise<number> {
  let copied = 0;
  for (const symbol of await from.symbols()) {
    const step = await from.getStep(symbol);
    if (step !== null) await to.setStep(symbol, step);
    for (const chunk of await from.chunks(symbol, sinceMs)) {
      await to.putChunk(chunk);
      copied++;
    }
  }
  return copied;
}

/* ───────────────────────────── IndexedDB ───────────────────────────── */

export const DATABASE_NAME = "orderflow-terminal";

const META = "heatmapMeta";
const CHUNKS = "heatmapChunks";

/** Schema history. Append new migrations; never edit existing ones (see idb.ts). */
export const MIGRATIONS: readonly Migration[] = [
  // v1 — heatmap history: per-symbol step, and one-minute chunks keyed by [symbol, start].
  (db) => {
    db.createObjectStore(META, { keyPath: "symbol" });
    const chunks = db.createObjectStore(CHUNKS, { keyPath: ["symbol", "start"] });
    chunks.createIndex("byEnd", "end");
  },
];

export class IndexedDbHeatmapRepository implements HeatmapRepository {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = DATABASE_NAME): Promise<IndexedDbHeatmapRepository> {
    return new IndexedDbHeatmapRepository(await openDatabase(name, MIGRATIONS));
  }

  close(): void {
    this.db.close();
  }

  async getStep(symbol: string): Promise<number | null> {
    const row = await requestResult(this.db.transaction(META).objectStore(META).get(symbol));
    return (row as { step?: number } | undefined)?.step ?? null;
  }

  async setStep(symbol: string, step: number): Promise<void> {
    const tx = this.db.transaction(META, "readwrite");
    tx.objectStore(META).put({ symbol, step });
    await transactionDone(tx);
  }

  async putChunk(chunk: HeatmapChunk): Promise<void> {
    const tx = this.db.transaction(CHUNKS, "readwrite");
    tx.objectStore(CHUNKS).put(chunk);
    await transactionDone(tx);
  }

  async chunks(symbol: string, sinceMs: number): Promise<HeatmapChunk[]> {
    // Chunks start at most one minute before they end.
    const range = IDBKeyRange.bound([symbol, sinceMs - 60_000], [symbol, Number.MAX_SAFE_INTEGER]);
    const rows = await requestResult(this.db.transaction(CHUNKS).objectStore(CHUNKS).getAll(range));
    return (rows as HeatmapChunk[]).filter((c) => c.end > sinceMs);
  }

  async symbols(): Promise<string[]> {
    const keys = await requestResult(this.db.transaction(META).objectStore(META).getAllKeys());
    return keys as string[];
  }

  async prune(beforeMs: number): Promise<number> {
    const tx = this.db.transaction(CHUNKS, "readwrite");
    const index = tx.objectStore(CHUNKS).index("byEnd");
    let removed = 0;
    const cursorRequest = index.openCursor(IDBKeyRange.upperBound(beforeMs, true));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      removed++;
      cursor.continue();
    };
    await transactionDone(tx);
    return removed;
  }
}
