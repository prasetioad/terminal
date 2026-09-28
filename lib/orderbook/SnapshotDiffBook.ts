import { SocketBook } from "./SocketBook";

export type Level = [price: string | number, size: string | number];

export interface BookSnapshot {
  id: number; // sequence / update id the snapshot is consistent with
  bids: Level[];
  asks: Level[];
}

export type Verdict = "ok" | "skip" | "gap";

const MAX_BUFFER = 20_000;
const RETRY_MS = 2_000;

/**
 * Order books built from a REST snapshot plus a sequenced diff stream (Binance, KuCoin):
 * buffer diffs, load the snapshot, drop diffs it already contains, then apply the rest
 * strictly in sequence. A gap re-fetches the snapshot; the socket stays up.
 */
export abstract class SnapshotDiffBook<E> extends SocketBook<E> {
  private buffer: E[] = [];
  private snapshotId = 0;
  /** Id of the last applied diff; null right after a snapshot. */
  private lastId: number | null = null;
  private pending: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  protected abstract fetchSnapshot(signal: AbortSignal): Promise<BookSnapshot>;
  /** Classify a diff: `lastId` is null for the first diff after the snapshot. */
  protected abstract accept(event: E, lastId: number | null, snapshotId: number): Verdict;
  /** Apply a diff's levels (`snapshotId` lets venues skip per-level changes already in it). */
  protected abstract applyEvent(event: E, snapshotId: number): void;
  protected abstract lastIdOf(event: E): number;

  protected onConnected(): void {
    this.resync();
  }

  protected onEvent(event: E): void {
    if (!this.live) {
      if (this.buffer.length < MAX_BUFFER) this.buffer.push(event);
      return;
    }
    this.applyInSequence(event);
  }

  protected onStop(): void {
    this.pending?.abort();
    this.pending = null;
    clearTimeout(this.retryTimer);
    this.buffer = [];
  }

  private resync(): void {
    this.onStop();
    this.live = false;
    this.book.clear();
    const controller = new AbortController();
    this.pending = controller;
    this.fetchSnapshot(controller.signal).then(
      (snapshot) => {
        if (controller.signal.aborted) return;
        this.book.clear();
        for (const [p, q] of snapshot.bids) this.setLevel("bid", p, q);
        for (const [p, q] of snapshot.asks) this.setLevel("ask", p, q);
        this.snapshotId = snapshot.id;
        this.lastId = null;
        const buffered = this.buffer;
        this.buffer = [];
        for (const e of buffered) if (!this.applyInSequence(e)) return;
        this.live = true;
      },
      () => {
        if (!controller.signal.aborted) this.retryTimer = setTimeout(() => this.resync(), RETRY_MS);
      },
    );
  }

  /** Returns false (and resyncs) when the diff doesn't continue the sequence. */
  private applyInSequence(event: E): boolean {
    const verdict = this.accept(event, this.lastId, this.snapshotId);
    if (verdict === "skip") return true;
    if (verdict === "gap") {
      this.resync();
      return false;
    }
    this.applyEvent(event, this.snapshotId);
    this.lastId = this.lastIdOf(event);
    return true;
  }
}
