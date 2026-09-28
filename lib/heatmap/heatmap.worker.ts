import { IndexedDbHeatmapRepository } from "../persistence/heatmapRepository";
import { HeatmapEngine } from "./engine";
import type { FromWorker, ToWorker } from "./protocol";

/**
 * Web Worker entry: order-book sockets, snapshots (Coinbase's is ~40k levels) and
 * ~1,000 depth messages/s never touch the page's main thread. Only one frame per
 * second crosses over.
 */
// Typed minimally: the project compiles against the DOM lib, which clashes with the webworker lib.
const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};
const post = (message: FromWorker) => scope.postMessage(message);

// History is optional: without IndexedDB (private mode, blocked storage) the heatmap still runs live.
const engine = IndexedDbHeatmapRepository.open().then(
  (repo) => new HeatmapEngine(post, repo),
  () => new HeatmapEngine(post, null),
);

// Configs are applied in order, each after the previous one finished.
let queue = Promise.resolve();
scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === "configure") {
    queue = queue.then(async () => (await engine).configure(message.config)).catch(() => {});
  }
};
