"use client";

import { useEffect, useState } from "react";
import { EMPTY_PRESSURE, PRESSURE_RANGES, type Pressure, type PressureRange, type PressureTape } from "@/lib/pressure";
import { measurePressure, type TradeFilter, type TradeLog } from "@/lib/tradeLog";

export interface FlowPressure {
  /** Big trades that pass the viewer's filter. */
  large: Pressure;
  /** Every print on the visible sources, whatever its size. */
  market: Pressure;
  /**
   * Start of the data behind both numbers (null before the first print). Trades are
   * only seen live, so a range longer than the page has been open is still filling.
   */
  from: number | null;
  /** How much time that data spans, to the minute. */
  coveredMs: number;
  /** Whether the data spans the whole range. */
  complete: boolean;
}

const EMPTY: FlowPressure = { large: EMPTY_PRESSURE, market: EMPTY_PRESSURE, from: null, coveredMs: 0, complete: false };
const REFRESH_MS = 500;
/** Coverage is shown to the minute: finer changes don't re-render. */
const COVERAGE_STEP_MS = 60_000;

const same = (a: Pressure, b: Pressure) => a.buyUsd === b.buyUsd && a.sellUsd === b.sellUsd;
const sameFlow = (a: FlowPressure, b: FlowPressure) =>
  same(a.large, b.large) && same(a.market, b.market) && a.from === b.from && a.coveredMs === b.coveredMs && a.complete === b.complete;

/**
 * Large and whole-market taker pressure over the same window, measured together so
 * the two are always comparable. Recomputed on a timer because a rolling range
 * changes even when no trades arrive; state only updates when the numbers move.
 */
export function useFlowPressure(log: TradeLog, tape: PressureTape, filter: TradeFilter, range: PressureRange): FlowPressure {
  const [pressure, setPressure] = useState<FlowPressure>(EMPTY);

  useEffect(() => {
    const rangeMs = PRESSURE_RANGES[range];
    const measure = () => {
      const now = Date.now();
      // One window for both: if the log had to drop old trades, the market side starts there too.
      const from = Math.max(rangeMs === null ? Number.NEGATIVE_INFINITY : now - rangeMs, log.completeFrom);
      const started = tape.startedAt;
      const dataFrom = started === null ? null : Math.max(from, started);
      const next: FlowPressure = {
        large: measurePressure(log.trades, filter, from),
        market: Number.isFinite(from) ? tape.measure(from, filter.hiddenSources, now) : tape.measure(null, filter.hiddenSources),
        from: dataFrom === null ? null : Math.floor(dataFrom / COVERAGE_STEP_MS) * COVERAGE_STEP_MS,
        coveredMs: dataFrom === null ? 0 : Math.floor((now - dataFrom) / COVERAGE_STEP_MS) * COVERAGE_STEP_MS,
        complete: dataFrom !== null && (rangeMs === null ? !Number.isFinite(log.completeFrom) : now - dataFrom >= rangeMs - COVERAGE_STEP_MS),
      };
      setPressure((prev) => (sameFlow(prev, next) ? prev : next));
    };
    measure();
    const id = setInterval(measure, REFRESH_MS);
    return () => clearInterval(id);
  }, [log, tape, filter, range]);

  return pressure;
}
