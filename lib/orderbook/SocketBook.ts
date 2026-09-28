import { ManagedSocket } from "../streams/ManagedSocket";
import type { StreamSpec } from "../streams/types";
import type { ConnectionStatus } from "../types";
import type { Listing } from "../venues";
import { OrderBook, type BookSide } from "./book";

/** A venue order book kept in sync over its own socket. What the heatmap engine drives. */
export interface LiveBook {
  readonly book: OrderBook;
  /** True while the local book is a faithful copy of the venue's. */
  readonly isLive: boolean;
  readonly status: ConnectionStatus;
  start(): void;
  stop(): void;
}

/**
 * Base for venue order-book adapters. Owns the socket; a subclass only says what to do
 * when the socket (re)connects and how to apply each message. Prices and sizes are
 * normalised with the listing's scale factors, so every venue's book is in the same units.
 */
export abstract class SocketBook<E> implements LiveBook {
  readonly book = new OrderBook();
  status: ConnectionStatus = "connecting";
  protected live = false;
  private readonly socket: ManagedSocket<E>;

  protected constructor(
    protected readonly listing: Listing,
    spec: StreamSpec<E>,
  ) {
    this.socket = new ManagedSocket<E>({
      spec,
      onEvent: (event) => this.onEvent(event),
      onStatus: (status) => {
        this.status = status;
        if (status === "connected") this.onConnected();
        else this.live = false; // anything missed while down makes the book stale
      },
    });
  }

  get isLive(): boolean {
    return this.live;
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
    this.onStop();
    this.live = false;
    this.book.clear();
  }

  /** Socket (re)connected: rebuild the book from a fresh snapshot. */
  protected abstract onConnected(): void;
  protected abstract onEvent(event: E): void;
  /** Release adapter resources (pending requests, buffers). */
  protected onStop(): void {}

  /** For venues that only send a snapshot on subscribe: a gap means reconnecting. */
  protected resubscribe(): void {
    this.live = false;
    this.book.clear();
    this.socket.restart();
  }

  protected setLevel(side: BookSide, price: string | number, size: string | number): void {
    this.book.set(side, Number(price) * this.listing.priceScale, Number(size) * this.listing.qtyScale);
  }
}
