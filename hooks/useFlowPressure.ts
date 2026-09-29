"use client";

import { useEffect, useState } from "react";
import { EMPTY_PRESSURE, PRESSURE_RANGES, type Pressure, type PressureRange, type PressureTape } from "@/lib/pressure";
import { measurePressure, type TradeFilter } from "@/lib/tradeLog";
import type { Trade } from "@/lib/types";

export interface FlowPressure {
  /** Big trades that pass the viewer's filter. */
  large: Pressure;
  /** Every print on the visible sources, whatever its size. */
  market: Pressure;
}

const EMPTY: FlowPressure = { large: EMPTY_PRESSURE, market: EMPTY_PRESSURE };
const REFRESH_MS = 500;

const same = (a: Pressure, b: Pressure) => a.buyUsd === b.buyUsd && a.sellUsd === b.sellUsd;

/**
 * Large and whole-market taker pressure over the same range, measured together so
 * the two are always comparable. Recomputed on a timer because a rolling range
 * changes even when no trades arrive; state only updates when the numbers move.
 */
export function useFlowPressure(
  trades: readonly Trade[],
  tape: PressureTape,
  filter: TradeFilter,
  range: PressureRange,
): FlowPressure {
  const [pressure, setPressure] = useState<FlowPressure>(EMPTY);

  useEffect(() => {
    const rangeMs = PRESSURE_RANGES[range];
    const measure = () => {
      const since = rangeMs === null ? null : Date.now() - rangeMs;
      const next: FlowPressure = {
        large: measurePressure(trades, filter, since ?? Number.NEGATIVE_INFINITY),
        market: tape.measure(since, filter.hiddenSources),
      };
      setPressure((prev) => (same(prev.large, next.large) && same(prev.market, next.market) ? prev : next));
    };
    measure();
    const id = setInterval(measure, REFRESH_MS);
    return () => clearInterval(id);
  }, [trades, tape, filter, range]);

  return pressure;
}
