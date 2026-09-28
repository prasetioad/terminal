import type { ConnectionStatus } from "../types";
import type { SourceId } from "../venues";
import { frameBytes, type HeatmapFrame } from "./frame";

export type { FrameSlice, HeatmapFrame } from "./frame";
export { SAMPLE_MS } from "./frame";

/** Frames kept for drawing; the oldest go first once this is exceeded. */
const MAX_BYTES = 96 * 1024 * 1024;

export interface BookStatus {
  connection: ConnectionStatus;
  live: boolean; // local book in sync
}

/**
 * The page-side heatmap: frames received from the heatmap worker (live + history),
 * kept sorted by time within a memory budget, plus the books' sync status. Drawing
 * code reads it; the worker is its only writer.
 */
export class HeatmapStore {
  private frames: HeatmapFrame[] = [];
  private bytes = 0;
  private stepSize = 0;
  private statuses: Partial<Record<SourceId, BookStatus>> = {};
  private readonly listeners = new Set<() => void>();

  /** Start a new recording (new symbol). */
  reset(step: number): void {
    this.frames = [];
    this.bytes = 0;
    this.stepSize = step;
    this.statuses = {};
    this.emit();
  }

  get step(): number {
    return this.stepSize;
  }

  get all(): readonly HeatmapFrame[] {
    return this.frames;
  }

  get latest(): HeatmapFrame | undefined {
    return this.frames[this.frames.length - 1];
  }

  get bookStatuses(): Readonly<Partial<Record<SourceId, BookStatus>>> {
    return this.statuses;
  }

  /** Add frames (any order, e.g. history arriving after live frames). */
  add(incoming: readonly HeatmapFrame[]): void {
    if (incoming.length === 0) return;
    const appendOnly = incoming.every((f, i) => f.time > (i === 0 ? (this.latest?.time ?? -Infinity) : incoming[i - 1].time));
    if (appendOnly) {
      // Live: frames arrive in order, one per second.
      for (const f of incoming) {
        this.frames.push(f);
        this.bytes += frameBytes(f);
      }
    } else {
      // History: merge by time; a frame at an existing time replaces it.
      const byTime = new Map(this.frames.map((f) => [f.time, f]));
      for (const f of incoming) byTime.set(f.time, f);
      this.frames = [...byTime.values()].sort((a, b) => a.time - b.time);
      this.bytes = this.frames.reduce((sum, f) => sum + frameBytes(f), 0);
    }
    let drop = 0;
    while (this.bytes > MAX_BYTES && drop < this.frames.length - 1) this.bytes -= frameBytes(this.frames[drop++]);
    if (drop > 0) this.frames.splice(0, drop);
    this.emit();
  }

  setStatuses(statuses: Partial<Record<SourceId, BookStatus>>): void {
    this.statuses = statuses;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
