import type { ConnectionStatus } from "../types";
import type { MarketEvent, StreamSpec } from "./types";

const CONNECT_TIMEOUT_MS = 6_000; // a blocked host may hang in CONNECTING instead of failing
const STALE_AFTER_MS = 30_000; // every feed sends at least a heartbeat well within this
const WATCHDOG_EVERY_MS = 5_000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/** Last URL index that connected, per static URL list, shared across instances. */
const preferredUrl = new Map<string, number>();

interface ManagedSocketOptions<E> {
  spec: StreamSpec<E>;
  onEvent: (event: E) => void;
  onStatus: (status: ConnectionStatus) => void;
}

/**
 * A WebSocket that stays connected: exponential backoff with host rotation (or a
 * freshly resolved URL per attempt), connect timeout, stale-stream watchdog, client
 * heartbeats and online/offline handling. `stop()` detaches every listener, timer and
 * pending URL request, so nothing fires afterwards.
 */
export class ManagedSocket<E = MarketEvent> {
  private readonly spec: StreamSpec<E>;
  private readonly onEvent: (event: E) => void;
  private readonly onStatus: (status: ConnectionStatus) => void;
  private readonly urlKey: string;

  private ws: WebSocket | null = null;
  private resolving: AbortController | null = null;
  private stopped = true;
  private attempt = 0;
  private urlIndex: number;
  private lastMessageAt = 0;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;

  constructor({ spec, onEvent, onStatus }: ManagedSocketOptions<E>) {
    this.spec = spec;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.urlKey = spec.urls?.join("|") ?? spec.key;
    this.urlIndex = preferredUrl.get(this.urlKey) ?? 0;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // globalThis: works on the page and inside Web Workers alike.
    globalThis.addEventListener("online", this.handleOnline);
    globalThis.addEventListener("offline", this.handleOffline);
    this.watchdogTimer = setInterval(this.checkStale, WATCHDOG_EVERY_MS);
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    globalThis.removeEventListener("online", this.handleOnline);
    globalThis.removeEventListener("offline", this.handleOffline);
    clearInterval(this.watchdogTimer);
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.onStatus("disconnected");
  }

  /**
   * Drop the current connection and connect again right away. For feeds whose state
   * can only be rebuilt from a fresh subscription (e.g. an order book after a gap).
   */
  restart(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.attempt = 0;
    this.connect();
  }

  private connect = (): void => {
    if (this.stopped) return;
    this.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const { spec } = this;
    if (!spec.resolveUrl) {
      this.open(spec.urls[this.urlIndex]);
      return;
    }
    const controller = new AbortController();
    this.resolving = controller;
    spec.resolveUrl(AbortSignal.any([controller.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)])).then(
      (url) => {
        if (this.resolving !== controller) return; // torn down meanwhile
        this.resolving = null;
        this.open(url);
      },
      () => {
        if (this.resolving !== controller) return;
        this.resolving = null;
        this.scheduleReconnect();
      },
    );
  };

  private open(url: string): void {
    const socket = new WebSocket(url);
    this.ws = socket;
    this.connectTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      clearTimeout(this.connectTimer);
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      if (this.spec.urls) preferredUrl.set(this.urlKey, this.urlIndex);
      for (const message of this.spec.subscribe ?? []) socket.send(message);
      const heartbeat = this.spec.heartbeat;
      if (heartbeat) {
        this.heartbeatTimer = setInterval(() => socket.send(heartbeat.message), heartbeat.intervalMs);
      }
      this.onStatus("connected");
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      this.lastMessageAt = Date.now();
      this.spec.parse(event.data, this.onEvent);
    };

    // onclose always follows onerror; reconnect is handled there.
    socket.onclose = () => this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.teardown();
    if (this.spec.urls) this.urlIndex = (this.urlIndex + 1) % this.spec.urls.length;
    this.onStatus("reconnecting");
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.attempt, MAX_BACKOFF_MS) + Math.random() * 250;
    this.attempt += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(this.connect, delay);
  }

  private teardown(): void {
    this.resolving?.abort();
    this.resolving = null;
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  private checkStale = (): void => {
    if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
      this.scheduleReconnect();
    }
  };

  private handleOnline = (): void => {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.attempt = 0;
    this.connect();
  };

  private handleOffline = (): void => this.onStatus("disconnected");
}
