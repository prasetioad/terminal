import type { Listing, SourceId } from "../venues";
import type { HeatmapFrame } from "./frame";
import type { BookStatus } from "./store";

/** Which books to run. `sources` empty = record nothing (sockets closed). */
export interface EngineConfig {
  symbol: string;
  minMove: number;
  listings: Listing[];
  sources: SourceId[];
}

export type ToWorker = { type: "configure"; config: EngineConfig };

/** Every message names its symbol so the page can drop replies to a superseded one. */
export type FromWorker =
  | { type: "reset"; symbol: string; step: number }
  | { type: "frames"; symbol: string; step: number; frames: HeatmapFrame[] }
  | { type: "status"; symbol: string; statuses: Partial<Record<SourceId, BookStatus>> };
