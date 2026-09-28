"use client";

import { useEffect, useRef, useState } from "react";
import type { EngineConfig, FromWorker, ToWorker } from "@/lib/heatmap/protocol";
import { HeatmapStore } from "@/lib/heatmap/store";
import type { Pair } from "@/lib/types";
import type { SourceId } from "@/lib/venues";

/**
 * Runs the heatmap engine in a Web Worker and mirrors its frames into a page-side
 * store for drawing. Order books stream only for `sources`; an empty list closes them.
 * The worker also persists history, so a reload shows the recent past immediately.
 */
export function useHeatmapEngine({ pair, sources }: { pair: Pair; sources: readonly SourceId[] }): HeatmapStore {
  const [store] = useState(() => new HeatmapStore());
  const workerRef = useRef<Worker | null>(null);
  const symbolRef = useRef(pair.symbol);

  useEffect(() => {
    const worker = new Worker(new URL("../lib/heatmap/heatmap.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.symbol !== symbolRef.current) return; // reply for a symbol we already left
      switch (message.type) {
        case "reset":
          store.reset(message.step);
          break;
        case "frames":
          if (store.step === 0) store.reset(message.step);
          store.add(message.frames);
          break;
        case "status":
          store.setStatuses(message.statuses);
          break;
      }
    };
    workerRef.current = worker;
    return () => {
      workerRef.current = null;
      worker.terminate(); // closes every order-book socket with it
    };
  }, [store]);

  const sourcesKey = [...sources].sort().join(",");
  useEffect(() => {
    symbolRef.current = pair.symbol;
    const config: EngineConfig = {
      symbol: pair.symbol,
      minMove: pair.minMove,
      listings: pair.listings,
      sources: sourcesKey ? (sourcesKey.split(",") as SourceId[]) : [],
    };
    workerRef.current?.postMessage({ type: "configure", config } satisfies ToWorker);
  }, [pair.symbol, pair.minMove, pair.listings, sourcesKey]);

  return store;
}
