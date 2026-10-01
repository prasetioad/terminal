"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PriceChartHandle } from "@/components/chart/PriceChart";
import { useMarketStreams, type SourceStatuses } from "./useMarketStreams";
import { fetchKlines, fetchPerpFlowHistory, fetchTicker24h } from "@/lib/binance";
import { CandleAggregator } from "@/lib/candles";
import { TakerOrderClusterer } from "@/lib/clusterer";
import { FlowStore } from "@/lib/flow";
import { PressureTape } from "@/lib/pressure";
import { streamSpecsFor, type MarketEvent } from "@/lib/streams";
import { EMPTY_STATS, TradeLog, isVisible, type FlowSummary, type TradeFilter } from "@/lib/tradeLog";
import { CHART_SOURCE } from "@/lib/venues";
import { INTERVALS, type Candle, type HistoryStatus, type IntervalKey, type Pair, type Ticker24h, type Trade } from "@/lib/types";

const MAX_CANDLES = 5_000;
const CANDLE_TRIM_SLACK = 500;
const MAX_PENDING_TRADES = 50_000;
const FEED_ROWS = 250;
const UI_FLUSH_MS = 200;

interface UseOrderflowOptions {
  pair: Pair;
  interval: IntervalKey;
  filter: TradeFilter;
  chartRef: RefObject<PriceChartHandle | null>;
  /** Called on the hot path for every new trade that passes `filter`. */
  onBigTrade?: (trade: Trade) => void;
}

interface MarketView extends FlowSummary {
  lastPrice: number | null;
  ticker: Ticker24h | null;
}

export interface Orderflow extends MarketView {
  statuses: SourceStatuses;
  historyStatus: HistoryStatus;
  /** Live, chronologically ordered buffer of trades from every source, read directly by the chart. */
  trades: readonly Trade[];
  /** The big-trade log behind `trades` (for how far back it is complete). */
  log: TradeLog;
  /** Per-venue taker buy/sell per bar, read directly by the flow indicators. */
  flow: FlowStore;
  /** Every print's notional by side and source, for whole-market pressure. */
  tape: PressureTape;
  clearLog: () => void;
}

const INITIAL_VIEW: MarketView = { feed: [], stats: EMPTY_STATS, lastPrice: null, ticker: null };

/**
 * Owns the market data pipeline for one pair + timeframe:
 *
 *   venue feeds ─┬─ chart source trades ─→ candles ─→ chart + indicators
 *                ├─ all trades ─→ flow store (buy/sell per venue per bar) ─→ Delta, CVD
 *                ├─ all trades ─→ pressure tape (buy/sell per source per second) ─→ market pressure
 *                └─ all trades ─→ taker-order clusterer ─→ big-trade log ─→ bubbles, feed, stats
 *
 * Ticks arrive dozens of times per second, so they only mutate buffers. The chart
 * is flushed once per animation frame and React state at most every UI_FLUSH_MS.
 */
export function useOrderflow({ pair, interval, filter, chartRef, onBigTrade }: UseOrderflowOptions): Orderflow {
  const { symbol } = pair;
  const [candles] = useState(() => new CandleAggregator(INTERVALS[interval]));
  const [log] = useState(() => new TradeLog());
  const [flow] = useState(() => new FlowStore(INTERVALS[interval]));
  const [tape] = useState(() => new PressureTape());
  const [view, setView] = useState<MarketView>(INITIAL_VIEW);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("loading");

  /** Chart-source trades that arrive while history is loading; null once the dataset is seeded. */
  const pendingRef = useRef<Trade[] | null>([]);
  const latestRef = useRef<Pick<MarketView, "lastPrice" | "ticker">>({ lastPrice: null, ticker: null });
  const filterRef = useRef(filter);
  const onBigTradeRef = useRef(onBigTrade);
  const frameRef = useRef<number | null>(null);
  const bubblesDirtyRef = useRef(false);
  const viewDirtyRef = useRef(false);

  useEffect(() => {
    onBigTradeRef.current = onBigTrade;
  }, [onBigTrade]);

  const publishView = useCallback(() => {
    viewDirtyRef.current = false;
    setView({ ...log.summarize(filterRef.current, FEED_ROWS), ...latestRef.current });
  }, [log]);

  const flushChart = useCallback(() => {
    frameRef.current = null;
    const chart = chartRef.current;
    if (!chart) return;

    if (candles.trim(MAX_CANDLES, CANDLE_TRIM_SLACK)) {
      chart.setCandles(candles.candles);
    } else {
      const from = candles.takeDirtyFrom();
      if (from !== null) chart.updateCandles(candles.candles, from);
    }

    const flowFrom = flow.takeDirtyFrom();
    if (flowFrom !== null) chart.refreshFlow(flowFrom);

    if (bubblesDirtyRef.current) {
      bubblesDirtyRef.current = false;
      chart.refreshBubbles();
    }
  }, [candles, flow, chartRef]);

  const scheduleChartFlush = useCallback(() => {
    frameRef.current ??= requestAnimationFrame(flushChart);
  }, [flushChart]);

  /** A complete taker order from any venue. */
  const onClusteredTrade = useCallback(
    (trade: Trade) => {
      if (!log.add(trade)) return;
      viewDirtyRef.current = true;
      if (!isVisible(trade, filterRef.current)) return;
      bubblesDirtyRef.current = true;
      onBigTradeRef.current?.(trade);
      scheduleChartFlush();
    },
    [log, scheduleChartFlush],
  );

  const onClusteredRef = useRef(onClusteredTrade);
  useEffect(() => {
    onClusteredRef.current = onClusteredTrade;
  }, [onClusteredTrade]);
  const [clusterer] = useState(() => new TakerOrderClusterer((trade) => onClusteredRef.current(trade)));

  const onEvent = useCallback(
    (event: MarketEvent) => {
      if (event.type === "ticker") {
        latestRef.current.ticker = event.ticker;
        viewDirtyRef.current = true;
        return;
      }

      const { trade, orderKey } = event;
      flow.add(trade);
      tape.add(trade);
      if (trade.source === CHART_SOURCE) {
        latestRef.current.lastPrice = trade.price;
        viewDirtyRef.current = true;
        const pending = pendingRef.current;
        if (pending === null) candles.apply(trade);
        else if (pending.length < MAX_PENDING_TRADES) pending.push(trade);
      }
      scheduleChartFlush();
      clusterer.push(trade, orderKey);
    },
    [candles, flow, tape, clusterer, scheduleChartFlush],
  );

  const specs = useMemo(() => streamSpecsFor(pair.listings), [pair.listings]);
  const statuses = useMarketStreams(specs, onEvent);

  // Throttled React updates for the header, feed and stats.
  useEffect(() => {
    const id = setInterval(() => {
      if (viewDirtyRef.current) publishView();
    }, UI_FLUSH_MS);
    return () => clearInterval(id);
  }, [publishView]);

  // A new filter re-summarizes immediately instead of waiting for the next tick.
  useEffect(() => {
    filterRef.current = filter;
    publishView();
  }, [filter, publishView]);

  // The big-trade log, pressure tape and ticker belong to one asset: start over on symbol change.
  useEffect(() => {
    clusterer.clear();
    log.clear();
    tape.clear();
    latestRef.current = { lastPrice: null, ticker: null };
    publishView();
    chartRef.current?.refreshBubbles();
  }, [symbol, clusterer, log, tape, chartRef, publishView]);

  // Seed the header from REST; a ticker from the live stream (fresher) wins if it came first.
  useEffect(() => {
    const controller = new AbortController();
    fetchTicker24h(symbol, controller.signal).then(
      (ticker) => {
        if (controller.signal.aborted || latestRef.current.ticker) return;
        latestRef.current.ticker = ticker;
        viewDirtyRef.current = true;
      },
      () => {}, // the stream fills it in on the next change
    );
    return () => controller.abort();
  }, [symbol]);

  // New dataset on symbol or timeframe change: seed from REST, then replay the
  // chart-source ticks that arrived while the request was in flight.
  useEffect(() => {
    const controller = new AbortController();
    const intervalMs = INTERVALS[interval];

    candles.reset(intervalMs);
    flow.reset(intervalMs);
    pendingRef.current = [];
    chartRef.current?.loadCandles([]);
    setHistoryStatus("loading");

    const seed = (history: Candle[], outcome: HistoryStatus) => {
      if (controller.signal.aborted) return;
      candles.reset(intervalMs, history);
      flow.seed(
        CHART_SOURCE,
        history.map((c) => ({ time: c.time, buy: c.buyVolume, sell: c.volume - c.buyVolume })),
      );
      for (const trade of pendingRef.current ?? []) candles.apply(trade);
      pendingRef.current = null;
      candles.takeDirtyFrom(); // loadCandles sends the whole series
      chartRef.current?.loadCandles(candles.candles);
      setHistoryStatus(outcome);
    };

    fetchKlines(symbol, interval, controller.signal).then(
      (history) => seed(history, "ready"),
      () => seed([], "error"), // no history: build the chart from live ticks only
    );

    return () => controller.abort();
  }, [symbol, interval, candles, flow, chartRef]);

  // Binance perpetual flow history, so perp Delta/CVD also reach back in time. Separate
  // from the candle seed because the listing only appears once the pair list has loaded.
  const perpListing = useMemo(() => pair.listings.find((l) => l.source === "binance:perp"), [pair.listings]);
  useEffect(() => {
    if (!perpListing) return;
    const controller = new AbortController();
    fetchPerpFlowHistory(perpListing, interval, controller.signal).then(
      (bars) => {
        if (controller.signal.aborted) return;
        flow.seed(perpListing.source, bars);
        scheduleChartFlush();
      },
      () => {}, // no perp history: perp flow starts live
    );
    return () => controller.abort();
  }, [perpListing, interval, flow, scheduleChartFlush]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      clusterer.clear();
    };
  }, [clusterer]);

  const clearLog = useCallback(() => {
    clusterer.clear();
    log.clear();
    tape.clear();
    publishView();
    chartRef.current?.refreshBubbles();
  }, [clusterer, log, tape, chartRef, publishView]);

  return { ...view, statuses, historyStatus, trades: log.trades, log, flow, tape, clearLog };
}
