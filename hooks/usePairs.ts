"use client";

import { useEffect, useState } from "react";
import type { SourceId } from "@/lib/venues";
import { DEFAULT_PAIRS, type Pair, type PairsResponse } from "@/lib/types";

export type PairsStatus = "loading" | PairsResponse["ranking"] | "error";

interface PairsState {
  pairs: Pair[];
  status: PairsStatus;
  unavailableSources: readonly SourceId[];
}

/** Loads the CMC-ranked pair list with venue listings once; falls back to Binance-only BTC/ETH. */
export function usePairs(): PairsState {
  const [state, setState] = useState<PairsState>({
    pairs: DEFAULT_PAIRS,
    status: "loading",
    unavailableSources: [],
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/pairs", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<PairsResponse>;
      })
      .then((data) => {
        setState({ pairs: data.pairs, status: data.ranking, unavailableSources: data.unavailableSources });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((s) => ({ ...s, status: "error" }));
      });
    return () => controller.abort();
  }, []);

  return state;
}
