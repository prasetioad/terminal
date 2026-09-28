"use client";

import { useEffect, useState } from "react";
import { EMPTY_PRESSURE, measurePressure, type Pressure, type TradeFilter } from "@/lib/tradeLog";
import type { Trade } from "@/lib/types";

export const PRESSURE_RANGES = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  Session: null,
} as const;

export type PressureRange = keyof typeof PRESSURE_RANGES;

const REFRESH_MS = 500;

/**
 * Aggressive buy vs sell notional over a rolling range. Recomputed on a timer
 * because a rolling range changes even when no new trades arrive; state only
 * updates when the numbers actually move.
 */
export function useTakerPressure(trades: readonly Trade[], filter: TradeFilter, range: PressureRange): Pressure {
  const [pressure, setPressure] = useState<Pressure>(EMPTY_PRESSURE);

  useEffect(() => {
    const rangeMs = PRESSURE_RANGES[range];
    const measure = () => {
      const since = rangeMs === null ? Number.NEGATIVE_INFINITY : Date.now() - rangeMs;
      const next = measurePressure(trades, filter, since);
      setPressure((prev) => (prev.buyUsd === next.buyUsd && prev.sellUsd === next.sellUsd ? prev : next));
    };
    measure();
    const id = setInterval(measure, REFRESH_MS);
    return () => clearInterval(id);
  }, [trades, filter, range]);

  return pressure;
}
