import { BOOK_FACTORIES, type LiveBook } from "../orderbook";
import type { OrderBook } from "../orderbook/book";
import type { HeatmapChunk, HeatmapRepository } from "../persistence/heatmapRepository";
import type { Listing, SourceId } from "../venues";
import { RANGE_PCT, SAMPLE_MS, buildFrame, chooseStep, mergeFrames, midOf, type HeatmapFrame } from "./frame";
import type { EngineConfig, FromWorker } from "./protocol";
import type { BookStatus } from "./store";

/** History is stored at this resolution (max of the 1 s frames inside each period). */
export const HISTORY_FRAME_MS = 5_000;
const CHUNK_MS = 60_000;
/** Kept on disk. */
export const RETENTION_MS = 12 * 60 * 60 * 1000;
/** Loaded when a symbol opens (the page keeps frames within a memory budget anyway). */
const HISTORY_LOAD_MS = 6 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 10 * 60 * 1000;
/** Book levels beyond this distance from mid are never drawn, so they're dropped. */
const PRUNE_BOOK_PCT = RANGE_PCT * 3;

/**
 * The heatmap engine (runs in a Web Worker): keeps the configured venue order books
 * in sync, samples them into a frame every second, sends frames to the page, and
 * persists a 5 s downsampled copy so the heatmap has history after a reload.
 */
export class HeatmapEngine {
  private readonly books = new Map<SourceId, LiveBook>();
  private symbol: string | null = null;
  private minMove = 0;
  private step = 0;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
  /** 1 s frames of the history period being filled, and the minute chunk they go into. */
  private period: HeatmapFrame[] = [];
  private chunk: HeatmapChunk | null = null;

  constructor(
    private readonly post: (message: FromWorker) => void,
    private readonly repo: HeatmapRepository | null,
  ) {
    if (repo) {
      const prune = () => void repo.prune(Date.now() - RETENTION_MS).catch(() => {});
      prune();
      this.pruneTimer = setInterval(prune, PRUNE_EVERY_MS);
    }
  }

  async configure(config: EngineConfig): Promise<void> {
    if (config.symbol !== this.symbol) await this.openSymbol(config);
    if (config.symbol !== this.symbol) return; // superseded while loading
    this.syncBooks(config.listings, config.sources);
  }

  dispose(): void {
    clearInterval(this.pruneTimer);
    this.stopAll();
  }

  private async openSymbol(config: EngineConfig): Promise<void> {
    this.stopAll();
    const generation = ++this.generation;
    this.symbol = config.symbol;
    this.minMove = config.minMove;
    this.step = (await this.repo?.getStep(config.symbol).catch(() => null)) ?? 0;
    if (generation !== this.generation) return;
    this.post({ type: "reset", symbol: config.symbol, step: this.step });
    await this.loadHistory(config.symbol, generation);
  }

  private async loadHistory(symbol: string, generation: number): Promise<void> {
    if (!this.repo || this.step === 0) return;
    const chunks = await this.repo.chunks(symbol, Date.now() - HISTORY_LOAD_MS).catch(() => []);
    if (generation !== this.generation) return;
    // Only chunks on the current bucket grid can be drawn together.
    const frames = chunks.filter((c) => c.step === this.step).flatMap((c) => c.frames);
    if (frames.length) this.post({ type: "frames", symbol, step: this.step, frames });
  }

  private syncBooks(listings: readonly Listing[], sources: readonly SourceId[]): void {
    const wanted = new Map<SourceId, Listing>();
    for (const source of sources) {
      const listing = listings.find((l) => l.source === source);
      if (listing) wanted.set(source, listing);
    }
    for (const [source, book] of this.books) {
      if (wanted.has(source)) continue;
      book.stop();
      this.books.delete(source);
    }
    for (const [source, listing] of wanted) {
      if (this.books.has(source)) continue;
      const book = BOOK_FACTORIES[source](listing);
      book.start();
      this.books.set(source, book);
    }
    if (this.books.size > 0 && this.timer === undefined) this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    if (this.books.size === 0) this.stopTimer();
  }

  private sample(): void {
    const symbol = this.symbol;
    if (!symbol) return;
    const live = new Map<SourceId, OrderBook>();
    const statuses: Partial<Record<SourceId, BookStatus>> = {};
    for (const [source, book] of this.books) {
      statuses[source] = { connection: book.status, live: book.isLive };
      if (book.isLive) live.set(source, book.book);
    }
    this.post({ type: "status", symbol, statuses });

    const mid = midOf(live);
    if (mid === null) return;
    if (this.step === 0) {
      this.step = chooseStep(mid, this.minMove);
      void this.repo?.setStep(symbol, this.step).catch(() => {});
    }
    const frame = buildFrame(Date.now(), mid, live, this.step);
    this.post({ type: "frames", symbol, step: this.step, frames: [frame] });
    this.persist(symbol, frame);
    for (const book of live.values()) book.prune(mid, PRUNE_BOOK_PCT);
  }

  /** Downsample to HISTORY_FRAME_MS and write the minute chunk as it fills. */
  private persist(symbol: string, frame: HeatmapFrame): void {
    if (!this.repo) return;
    const periodOf = (t: number) => Math.floor(t / HISTORY_FRAME_MS) * HISTORY_FRAME_MS;
    const open = this.period[0];
    if (open && periodOf(open.time) !== periodOf(frame.time)) this.closePeriod(symbol);
    this.period.push(frame);
  }

  private closePeriod(symbol: string): void {
    const repo = this.repo;
    const first = this.period[0];
    if (!repo || !first) return;
    const start = Math.floor(first.time / HISTORY_FRAME_MS) * HISTORY_FRAME_MS;
    const merged = mergeFrames(this.period, start, HISTORY_FRAME_MS);
    this.period = [];

    const minute = Math.floor(start / CHUNK_MS) * CHUNK_MS;
    if (!this.chunk || this.chunk.start !== minute || this.chunk.symbol !== symbol) {
      this.chunk = { symbol, start: minute, end: minute + CHUNK_MS, step: this.step, frames: [] };
    }
    this.chunk.frames.push(merged);
    void repo.putChunk(this.chunk).catch(() => {}); // storage full / unavailable: keep running live
  }

  private stopAll(): void {
    if (this.symbol) this.closePeriod(this.symbol);
    this.chunk = null;
    this.stopTimer();
    for (const book of this.books.values()) book.stop();
    this.books.clear();
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
