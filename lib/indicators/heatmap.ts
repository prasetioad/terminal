import type { Logical } from "lightweight-charts";
import { CanvasPrimitive, type DrawScope } from "../chart/CanvasPrimitive";
import { logicalToTime } from "../chart/timeAxis";
import { formatPrice, formatSigned } from "../format";
import { rasterize, scaleGradientCss, type ColorScale, type HeatmapImage, type HeatmapStats } from "../heatmap/render";
import type { HeatmapFrame } from "../heatmap/store";
import { ALL_SOURCES, splitSource, type SourceId } from "../venues";
import { flowSummary, xAtTime } from "./common";
import type { ColorScaleState, IndicatorConfig, IndicatorData, IndicatorDefinition, IndicatorParams, LegendValue } from "./types";

const TYPE = "liquidity-heatmap";
/** The live depth histogram uses the empty space right of the last bar, up to this share of the pane. */
const DEPTH_MAX_SHARE = 0.15;
const DEPTH_MIN_PX = 24;

/** Books summed into the heatmap: Binance only, or the global book across every venue. */
function sourcesOf(params: IndicatorParams): SourceId[] {
  const market = String(params.market ?? "both");
  const binanceOnly = params.venues === "binance";
  return ALL_SOURCES.filter((s) => {
    const { venue, market: m } = splitSource(s);
    return (market === "both" || m === market) && (!binanceOnly || venue === "binance");
  });
}

/** Order-book sources every configured heatmap needs recorded (hidden ones keep recording). */
export function heatmapSources(configs: readonly IndicatorConfig[]): SourceId[] {
  const set = new Set<SourceId>();
  for (const c of configs) if (c.type === TYPE) for (const s of sourcesOf(c.params)) set.add(s);
  return [...set];
}

/** First frame index at or after `ms`. */
function frameIndexFrom(frames: readonly HeatmapFrame[], ms: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Resting size per merged row of one frame, summed over sources. */
function rowsOf(frame: HeatmapFrame, sources: readonly SourceId[], step: number, merge: number) {
  const rows = new Map<number, number>(); // row index (bucket / merge) → size
  for (const s of sources) {
    const slice = frame.slices.get(s);
    if (!slice) continue;
    slice.sizes.forEach((size, i) => {
      if (size <= 0) return;
      const row = Math.floor((slice.base + i) / merge);
      rows.set(row, (rows.get(row) ?? 0) + size);
    });
  }
  const rowPrice = (row: number) => (row * merge + merge / 2) * step;
  return { rows, rowPrice };
}

export const liquidityHeatmapIndicator: IndicatorDefinition = {
  type: TYPE,
  name: "Liquidity Heatmap",
  description:
    "Resting limit-order liquidity over time — bright bands are walls. Global book across all venues or Binance only; history is saved in the browser (12 h), with the current depth right of the live bar.",
  category: "Orderflow",
  placement: "overlay",
  params: [
    {
      key: "venues",
      label: "Venues",
      type: "select",
      default: "all",
      options: [
        { value: "all", label: "All venues (global book)" },
        { value: "binance", label: "Binance only" },
      ],
    },
    {
      key: "market",
      label: "Market",
      type: "select",
      default: "both",
      options: [
        { value: "both", label: "Spot + Perpetual" },
        { value: "spot", label: "Spot" },
        { value: "perp", label: "Perpetual" },
      ],
    },
    {
      key: "resolution",
      label: "Price resolution",
      type: "select",
      default: "2",
      options: [
        { value: "1", label: "Finest (0.005%)" },
        { value: "2", label: "Fine (0.01%)" },
        { value: "4", label: "Normal (0.02%)" },
        { value: "8", label: "Coarse (0.04%)" },
      ],
    },
    {
      key: "scaleMode",
      label: "Colour scale",
      type: "select",
      default: "auto",
      options: [
        { value: "auto", label: "Auto" },
        { value: "manual", label: "Manual (min / max)" },
      ],
    },
    { key: "contrast", label: "Contrast (auto scale)", type: "number", default: 5, min: 1, max: 10, step: 1 },
    { key: "scaleMin", label: "Min (USD, manual scale)", type: "number", default: 0, min: 0, max: 1e12, step: 10_000 },
    { key: "scaleMax", label: "Max (USD, manual scale)", type: "number", default: 5_000_000, min: 0, max: 1e12, step: 10_000 },
    { key: "showDepth", label: "Current book depth", type: "boolean", default: true },
  ],
  colorScaleParams: { mode: "scaleMode", min: "scaleMin", max: "scaleMax" },
  summary: (p) => `${flowSummary(p)} · ${p.scaleMode === "manual" ? "manual scale" : `contrast ${p.contrast}`}`,

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    let visible = true;
    let data: IndicatorData | null = null;
    let unsubscribe: (() => void) | null = null;
    let cache: { key: string; image: HeatmapImage | null; bucketLo: number } | null = null;
    /** Stats of the last drawn image, for the colour-scale legend. */
    let lastStats: HeatmapStats | null = null;

    const scaleOf = (): ColorScale =>
      params.scaleMode === "manual"
        ? { mode: "manual", min: Number(params.scaleMin), max: Number(params.scaleMax) }
        : { mode: "auto", contrast: Number(params.contrast) };

    const paint = (scope: DrawScope) => {
      const d = data;
      const store = d?.heatmap;
      if (!visible || !d || !store || store.step === 0 || d.candles.length === 0) return;
      const frames = store.all;
      if (frames.length === 0) return;
      const { chart, series, ctx: g, width, height } = scope;

      const range = chart.timeScale().getVisibleLogicalRange();
      if (!range) return;
      const fromMs = logicalToTime(d.candles, d.intervalMs, range.from);
      const toMs = logicalToTime(d.candles, d.intervalMs, range.to);
      const topPrice = series.coordinateToPrice(0);
      const bottomPrice = series.coordinateToPrice(height);
      if (fromMs === null || toMs === null || topPrice === null || bottomPrice === null) return;

      const merge = Number(params.resolution);
      const step = store.step;
      const from = Math.max(0, frameIndexFrom(frames, fromMs) - 1);
      const to = Math.min(frames.length - 1, frameIndexFrom(frames, toMs));
      if (to < from) return;
      // Align the bucket range to whole rows so rows don't shimmer while scrolling.
      const bucketLo = Math.floor(Math.min(topPrice, bottomPrice) / step / merge) * merge;
      const bucketHi = Math.ceil(Math.max(topPrice, bottomPrice) / step / merge) * merge + merge - 1;
      const sources = sourcesOf(params);

      const scale = scaleOf();
      const key = [from, to, frames[to].time, bucketLo, bucketHi, merge, Math.round(width), JSON.stringify(scale), sources.join()].join("|");
      if (!cache || cache.key !== key) {
        cache = {
          key,
          bucketLo,
          image: rasterize({ frames, from, to, sources, bucketLo, bucketHi, merge, step, maxColumns: Math.round(width), scale }),
        };
      }
      const image = cache.image;
      if (image) lastStats = image.stats;
      if (image) {
        const yTop = series.priceToCoordinate((bucketLo + image.rows * merge) * step);
        const yBottom = series.priceToCoordinate(bucketLo * step);
        if (yTop !== null && yBottom !== null) {
          g.imageSmoothingEnabled = false;
          image.spans.forEach((span, c) => {
            const x0 = xAtTime(scope, d, span.start);
            const x1 = xAtTime(scope, d, span.end);
            if (x0 === null || x1 === null || x1 < 0 || x0 > width) return;
            g.drawImage(image.canvas, c, 0, 1, image.rows, x0, yTop, Math.max(1, x1 - x0), yBottom - yTop);
          });
        }
      }

      if (params.showDepth) paintDepth(scope, frames[frames.length - 1], sources, step, merge, d.candles.length);
    };

    /** Current book depth, drawn in the empty space right of the live bar so it never covers candles. */
    const paintDepth = (scope: DrawScope, frame: HeatmapFrame, sources: readonly SourceId[], step: number, merge: number, barCount: number) => {
      const { ctx: g, series, width, chart } = scope;
      const ts = chart.timeScale();
      const lastX = ts.logicalToCoordinate((barCount - 1) as Logical);
      const nextX = ts.logicalToCoordinate(barCount as Logical);
      if (lastX === null || nextX === null) return;
      const maxLen = Math.min(width * DEPTH_MAX_SHARE, width - (lastX + (nextX - lastX) / 2) - 4);
      if (maxLen < DEPTH_MIN_PX) return; // scrolled so the live bar sits at the edge: no room
      const { rows, rowPrice } = rowsOf(frame, sources, step, merge);
      let max = 0;
      for (const size of rows.values()) max = Math.max(max, size);
      if (max <= 0) return;
      for (const [row, size] of rows) {
        const yTop = series.priceToCoordinate((row + 1) * merge * step);
        const yBottom = series.priceToCoordinate(row * merge * step);
        if (yTop === null || yBottom === null) continue;
        const len = (maxLen * size) / max;
        g.fillStyle = rowPrice(row) < frame.mid ? "rgba(0, 255, 163, 0.5)" : "rgba(255, 45, 85, 0.5)";
        g.fillRect(width - len, yTop, len, Math.max(1, yBottom - yTop - 0.5));
      }
    };

    const primitive = new CanvasPrimitive(paint, "background");
    ctx.priceSeries.attachPrimitive(primitive);

    const attach = (next: IndicatorData) => {
      if (data?.heatmap !== next.heatmap) {
        unsubscribe?.();
        unsubscribe = next.heatmap.subscribe(() => primitive.refresh());
      }
      data = next;
    };

    return {
      render(next) {
        attach(next);
        cache = null;
        primitive.refresh();
      },
      update(next) {
        attach(next);
        primitive.refresh();
      },
      setParams(next) {
        params = next;
        cache = null;
        primitive.refresh();
      },
      setVisible(next) {
        visible = next;
        primitive.refresh();
      },
      legend(d): LegendValue[] {
        const sources = sourcesOf(params);
        const statuses = d.heatmap.bookStatuses;
        const tracked = sources.filter((s) => statuses[s]);
        const live = tracked.filter((s) => statuses[s]?.live);
        const books: LegendValue = {
          label: "books",
          text: `${live.length}/${tracked.length}`,
          color: live.length === tracked.length ? "#64748B" : "#F59E0B",
        };
        const frame = d.heatmap.latest;
        if (!frame) return [{ text: "syncing order books…", color: "#64748B" }, books];
        const merge = Number(params.resolution);
        const { rows, rowPrice } = rowsOf(frame, sourcesOf(params), d.heatmap.step, merge);
        let bid: [number, number] | null = null;
        let ask: [number, number] | null = null;
        for (const [row, size] of rows) {
          const price = rowPrice(row);
          if (price < frame.mid && (!bid || size > bid[1])) bid = [price, size];
          if (price > frame.mid && (!ask || size > ask[1])) ask = [price, size];
        }
        const wall = (label: string, w: [number, number] | null, color: string): LegendValue[] =>
          w ? [{ label, text: `${formatPrice(w[0], d.precision)} (${formatSigned(w[1]).replace("+", "")})`, color }] : [];
        return [...wall("Bid wall", bid, "#00FFA3"), ...wall("Ask wall", ask, "#FF2D55"), books];
      },
      colorScale(): ColorScaleState | null {
        const manual = params.scaleMode === "manual";
        const min = manual ? Number(params.scaleMin) : (lastStats?.min ?? 0);
        const max = manual ? Number(params.scaleMax) : (lastStats?.max ?? 0);
        const dataMax = lastStats?.dataMax ?? 0;
        if (!manual && !lastStats) return null; // nothing drawn yet
        return { mode: manual ? "manual" : "auto", min, max, domainMax: Math.max(dataMax, max, min), gradient: scaleGradientCss() };
      },
      destroy() {
        unsubscribe?.();
        ctx.priceSeries.detachPrimitive(primitive);
      },
    };
  },
};
