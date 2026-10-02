import {
  BaselineSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type ISeriesApi,
  type Logical,
  type SeriesType,
  type Time,
  type WhitespaceData,
} from "lightweight-charts";
import { CanvasPrimitive, type DrawScope } from "../chart/CanvasPrimitive";
import type { DivergenceKind } from "../maxflow";
import { computeMaxFlowOF, type FilterKey, type FlowInputs, type MaxFlowOFResult, type SignalScore } from "../maxflowOF";
import { ALL_SOURCES, splitSource, type SourceId } from "../venues";
import { updateSeriesFrom, visibleBars } from "./common";
import type { IndicatorData, IndicatorDefinition, IndicatorParams, LegendValue } from "./types";

/**
 * MaxFlow+ OF (experimental): the MaxFlow+ Ultimate oscillator with real orderflow —
 * see lib/maxflowOF.ts. The original indicator is left as it is; this one is for
 * experimenting with orderflow filters on its signals.
 */

const HTF_OPTIONS = [
  { value: "15m", label: "15 minutes", ms: 900_000 },
  { value: "1h", label: "1 hour", ms: 3_600_000 },
  { value: "4h", label: "4 hours", ms: 14_400_000 },
  { value: "1d", label: "1 day", ms: 86_400_000 },
] as const;

const FILTERS: readonly { key: FilterKey; label: string; short: string; default: boolean }[] = [
  { key: "spotLed", label: "Filter: spot-led (spot takers on the signal's side)", short: "Spot-led", default: true },
  { key: "absorption", label: "Filter: absorption (price new extreme, CVD not)", short: "Absorption", default: false },
  { key: "flowConfirm", label: "Filter: spot + perp takers on the signal's side", short: "Flow", default: false },
  { key: "flowMomentum", label: "Filter: flow oscillator turning the signal's way", short: "Momentum", default: false },
];

const COLORS = {
  wt1: "#FFEB3B",
  wt2: "#1D4ED8",
  limit: "rgba(168, 85, 247, 0.6)",
  flowUp: "rgba(0, 255, 163, 0.55)",
  flowDown: "rgba(255, 45, 85, 0.6)",
  vwap: "rgba(229, 231, 235, 0.45)",
  zero: "rgba(255, 255, 255, 0.3)",
  tintBull: "rgba(76, 175, 80, 0.07)",
  tintBear: "rgba(242, 54, 69, 0.07)",
  green: "#00E676",
  red: "#F23645",
  rejected: "rgba(148, 163, 184, 0.75)",
  earlyGreen: "rgba(0, 188, 212, 0.8)",
  earlyRed: "rgba(255, 152, 0, 0.8)",
};

const DIVERGENCE_STYLE: Record<DivergenceKind, { color: string; up: boolean }> = {
  regularBull: { color: "#00E676", up: true },
  hiddenBull: { color: "rgba(0, 230, 118, 0.5)", up: true },
  regularBear: { color: "#F23645", up: false },
  hiddenBear: { color: "rgba(242, 54, 69, 0.5)", up: false },
};

/* ───────────────────────────── flow inputs ───────────────────────────── */

/**
 * Spot and perp taker flow per chart bar. Binance comes with kline history; "all"
 * venues only exist since streaming started, so earlier bars stay uncovered (NaN)
 * rather than mixing partial data in. Covered bars without trades count as 0.
 */
function flowInputs(data: IndicatorData, venues: "binance" | "all"): FlowInputs {
  const n = data.candles.length;
  const pick = (market: "spot" | "perp"): SourceId[] =>
    ALL_SOURCES.filter((s) => {
      const { venue, market: m } = splitSource(s);
      return m === market && (venues === "all" || venue === "binance");
    });
  const spot = pick("spot");
  const perp = pick("perp");
  const start = venues === "all" ? data.flow.liveStart : Number.NEGATIVE_INFINITY;
  const out: FlowInputs = {
    spotDelta: new Float64Array(n).fill(Number.NaN),
    spotVolume: new Float64Array(n).fill(Number.NaN),
    perpDelta: new Float64Array(n).fill(Number.NaN),
    perpVolume: new Float64Array(n).fill(Number.NaN),
  };
  for (let i = 0; i < n; i++) {
    const time = data.candles[i].time;
    if (time < start) continue;
    const s = data.flow.totals(time, spot) ?? { buy: 0, sell: 0 };
    const p = data.flow.totals(time, perp) ?? { buy: 0, sell: 0 };
    out.spotDelta[i] = s.buy - s.sell;
    out.spotVolume[i] = s.buy + s.sell;
    out.perpDelta[i] = p.buy - p.sell;
    out.perpVolume[i] = p.buy + p.sell;
  }
  return out;
}

const optionsOf = (p: IndicatorParams, intervalMs: number) => ({
  scalping: p.mode === "scalping",
  obosFilter: Boolean(p.obosFilter),
  divergence: Boolean(p.divergence),
  hiddenDivergence: Boolean(p.divergence),
  mtf: Boolean(p.mtf),
  htfMs: HTF_OPTIONS.find((o) => o.value === p.htf)?.ms ?? 3_600_000,
  intervalMs,
  dynamicBands: Boolean(p.dynamicBands),
  atrLength: 14,
  volumeArea: false,
  earlyWarning: Boolean(p.earlyWarning),
  mfLength: 14,
  mfSmooth: 3,
  vwapLength: 8,
  filters: Object.fromEntries(FILTERS.map((f) => [f.key, Boolean(p[f.key])])) as Record<FilterKey, boolean>,
  confirmBars: Number(p.confirmBars),
  flowLength: Number(p.flowLength),
  horizon: Number(p.horizon),
  markDeltaDivergences: Boolean(p.deltaDivergence),
});

const scoreText = (s: SignalScore) => (s.count ? `${s.count} · ${(s.winRate * 100).toFixed(0)}% · ${s.avgBp >= 0 ? "+" : ""}${s.avgBp.toFixed(0)}bp` : "0");

export const maxFlowOFIndicator: IndicatorDefinition = {
  type: "maxflow-of",
  name: "MaxFlow+ OF (experimental)",
  description:
    "Clone of MaxFlow+ Ultimate on real orderflow: a taker-flow oscillator instead of the RSI-of-volume money flow, signal dots filtered by spot / perp taker flow and absorption, placed on the bar they become known, with a live score of kept vs rejected signals.",
  category: "Orderflow",
  placement: "pane",
  usesFlow: true,
  params: [
    {
      key: "mode",
      label: "Trading mode preset",
      type: "select",
      default: "swing",
      options: [
        { value: "swing", label: "Swing / Standard" },
        { value: "scalping", label: "Scalping (Fast)" },
      ],
    },
    {
      key: "venues",
      label: "Flow from",
      type: "select",
      default: "binance",
      options: [
        { value: "binance", label: "Binance spot + perp (with history)" },
        { value: "all", label: "All venues (live since load)" },
      ],
    },
    ...FILTERS.map((f) => ({ key: f.key, label: f.label, type: "boolean" as const, default: f.default })),
    { key: "confirmBars", label: "└ Flow window (bars)", type: "number", default: 3, min: 1, max: 20, step: 1 },
    { key: "obosFilter", label: "Filter dots by OB/OS levels", type: "boolean", default: true },
    { key: "mtf", label: "Higher-timeframe trend bias", type: "boolean", default: true },
    {
      key: "htf",
      label: "└ Higher timeframe",
      type: "select",
      default: "1h",
      options: HTF_OPTIONS.map(({ value, label }) => ({ value, label })),
    },
    {
      key: "plotAt",
      label: "Place signals on",
      type: "select",
      default: "known",
      options: [
        { value: "known", label: "The bar they are known (tradable)" },
        { value: "cross", label: "The cross bar (as the original, 1 bar early)" },
      ],
    },
    { key: "showRejected", label: "Show rejected signals (grey rings)", type: "boolean", default: true },
    { key: "deltaDivergence", label: "Mark CVD divergences (◆)", type: "boolean", default: false },
    { key: "divergence", label: "WaveTrend divergences (▲▼)", type: "boolean", default: false },
    { key: "earlyWarning", label: "Early-warning dots", type: "boolean", default: false },
    { key: "dynamicBands", label: "Dynamic volatility bands (ATR)", type: "boolean", default: false },
    { key: "flowLength", label: "Flow oscillator length", type: "number", default: 14, min: 2, max: 100, step: 1 },
    { key: "horizon", label: "Score signals after (bars)", type: "number", default: 20, min: 1, max: 200, step: 1 },
  ],
  summary: (p) => {
    const filters = FILTERS.filter((f) => p[f.key]).map((f) => f.short);
    return `${p.mode === "scalping" ? "Scalping" : "Swing"} · ${filters.length ? filters.join("+") : "no flow filter"}`;
  },

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    let visible = true;
    let data: IndicatorData | null = null;
    let result: MaxFlowOFResult | null = null;

    const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    const upper = ctx.addSeries(LineSeries, { ...quiet, color: COLORS.limit, lineWidth: 1 });
    const lower = ctx.addSeries(LineSeries, { ...quiet, color: COLORS.limit, lineWidth: 1 });
    const wt1 = ctx.addSeries(HistogramSeries, { color: COLORS.wt1, priceLineVisible: false });
    const wt2 = ctx.addSeries(HistogramSeries, { color: COLORS.wt2, priceLineVisible: false });
    const area = (top: string, bottom: string) =>
      ctx.addSeries(BaselineSeries, {
        ...quiet,
        baseValue: { type: "price", price: 0 },
        lineWidth: 1,
        topLineColor: top,
        topFillColor1: top,
        topFillColor2: top,
        bottomLineColor: bottom,
        bottomFillColor1: bottom,
        bottomFillColor2: bottom,
      });
    const flowArea = area(COLORS.flowUp, COLORS.flowDown);
    const vwap = area(COLORS.vwap, COLORS.vwap);
    wt1.createPriceLine({ price: 0, color: COLORS.zero, lineStyle: LineStyle.Solid, lineWidth: 1, axisLabelVisible: false });

    const plots: [ISeriesApi<SeriesType>, (r: MaxFlowOFResult) => Float64Array][] = [
      [upper, (r) => r.base.devUpper],
      [lower, (r) => r.base.devLower],
      [wt1, (r) => r.base.wt1],
      [wt2, (r) => r.base.wt2],
      [flowArea, (r) => r.flowOsc],
      [vwap, (r) => r.base.vwapOsc],
    ];

    const point = (d: IndicatorData, values: Float64Array, i: number): { time: Time; value: number } | WhitespaceData<Time> => {
      const time = d.candles[i].time;
      const v = values[i];
      return v === undefined || Number.isNaN(v) ? { time } : { time, value: v };
    };

    const xOf = (scope: DrawScope, i: number) => scope.chart.timeScale().logicalToCoordinate(i as Logical);

    const paintTint = (scope: DrawScope) => {
      if (!visible || !params.mtf || !data || !result) return;
      const bars = visibleBars(scope, data);
      if (!bars) return;
      const { htfBias } = result.base;
      const width = (i: number) => {
        const a = xOf(scope, i);
        const b = xOf(scope, i + 1);
        return a === null ? null : { x: a, w: b === null ? 6 : b - a };
      };
      let start = bars.from;
      for (let i = bars.from; i <= bars.to + 1; i++) {
        if (i <= bars.to && htfBias[i] === htfBias[start]) continue;
        const a = width(start);
        const b = width(i - 1);
        if (htfBias[start] !== 0 && a && b) {
          scope.ctx.fillStyle = htfBias[start] > 0 ? COLORS.tintBull : COLORS.tintBear;
          scope.ctx.fillRect(a.x - a.w / 2, 0, b.x + b.w / 2 - (a.x - a.w / 2), scope.height);
        }
        start = i;
      }
    };

    const paintMarkers = (scope: DrawScope) => {
      if (!visible || !data || !result) return;
      const bars = visibleBars(scope, data);
      if (!bars) return;
      const { ctx: g, series } = scope;
      const r = result;
      const inView = (i: number) => i >= bars.from && i <= bars.to;
      const dot = (i: number, value: number, radius: number, fill: string | null, stroke?: string) => {
        const x = xOf(scope, i);
        const y = series.priceToCoordinate(value);
        if (x === null || y === null) return;
        g.beginPath();
        g.arc(x, y, radius, 0, Math.PI * 2);
        if (fill) {
          g.fillStyle = fill;
          g.fill();
        }
        if (stroke) {
          g.lineWidth = 1.5;
          g.strokeStyle = stroke;
          g.stroke();
        }
      };

      if (params.earlyWarning) {
        for (const d of r.base.dots) {
          if ((d.kind === "earlyGreen" || d.kind === "earlyRed") && inView(d.index)) dot(d.index, d.value, 2, d.kind === "earlyGreen" ? COLORS.earlyGreen : COLORS.earlyRed);
        }
      }
      const known = params.plotAt !== "cross";
      for (const s of r.signals) {
        const i = known ? s.index : s.index - 1;
        if (!inView(i)) continue;
        const value = known ? r.base.wt1[s.index] : s.value;
        const color = s.dir > 0 ? COLORS.green : COLORS.red;
        if (!s.failed.length) dot(i, value, 4, color, "rgba(11, 14, 17, 0.9)");
        else if (params.showRejected) dot(i, value, 4, null, COLORS.rejected);
      }
      if (params.divergence) {
        for (const div of r.base.divergences) {
          if (!inView(div.index)) continue;
          const x = xOf(scope, div.index);
          const y = series.priceToCoordinate(div.value);
          if (x === null || y === null) continue;
          const { color, up } = DIVERGENCE_STYLE[div.kind];
          const tip = up ? -5 : 5;
          g.beginPath();
          g.moveTo(x, y + tip);
          g.lineTo(x - 5, y - tip);
          g.lineTo(x + 5, y - tip);
          g.closePath();
          g.fillStyle = color;
          g.fill();
        }
      }
      if (params.deltaDivergence) {
        // Diamonds at the pane's edge on the side the move is expected to go.
        for (const d of r.deltaDivergences) {
          if (!inView(d.index)) continue;
          const x = xOf(scope, d.index);
          if (x === null) continue;
          const y = d.dir > 0 ? scope.height - 10 : 10;
          g.beginPath();
          g.moveTo(x, y - 5);
          g.lineTo(x + 4, y);
          g.lineTo(x, y + 5);
          g.lineTo(x - 4, y);
          g.closePath();
          g.fillStyle = d.dir > 0 ? COLORS.green : COLORS.red;
          g.fill();
        }
      }
    };

    const tint = new CanvasPrimitive(paintTint, "background");
    const markers = new CanvasPrimitive(paintMarkers, "top");
    wt1.attachPrimitive(tint);
    wt1.attachPrimitive(markers);

    const applyVisibility = () => {
      for (const [series] of plots) series.applyOptions({ visible });
      tint.refresh();
      markers.refresh();
    };
    applyVisibility();

    const recompute = (d: IndicatorData) => {
      data = d;
      const venues = params.venues === "all" ? "all" : "binance";
      result = computeMaxFlowOF(d.candles, flowInputs(d, venues), optionsOf(params, d.intervalMs));
      return result;
    };

    const renderAll = (d: IndicatorData) => {
      const r = recompute(d);
      for (const [series, values] of plots) series.setData(d.candles.map((_, i) => point(d, values(r), i)));
      tint.refresh();
      markers.refresh();
    };

    return {
      render: renderAll,
      update(d, from) {
        // Flow can arrive for older bars (the perp history, other venues): every series is
        // causal, so bars before `from` are unchanged; signals live in the primitive.
        const r = recompute(d);
        for (const [series, values] of plots) updateSeriesFrom(series, d.candles.length, from, (i) => point(d, values(r), i));
        tint.refresh();
        markers.refresh();
      },
      setParams(next) {
        params = next; // the host renders right after
      },
      setVisible(next) {
        visible = next;
        applyVisibility();
      },
      legend(_d, index): LegendValue[] {
        const r = result;
        const w1 = r?.base.wt1[index];
        if (!r || w1 === undefined || !Number.isFinite(w1)) return [];
        const values: LegendValue[] = [{ label: "WT", text: w1.toFixed(1), color: COLORS.wt1 }];
        const f = r.flowOsc[index];
        if (Number.isFinite(f)) values.push({ label: "Flow", text: f.toFixed(1), color: f >= 0 ? "#00FFA3" : "#FF2D55" });
        if (params.mtf && r.base.htfBias[index] !== 0) {
          const bull = r.base.htfBias[index] > 0;
          values.push({ label: "HTF", text: bull ? "▲ Bull" : "▼ Bear", color: bull ? "#22C55E" : "#EF4444" });
        }
        values.push(
          { label: `Kept·${r.score.horizon}b`, text: scoreText(r.score.kept), color: r.score.kept.avgBp >= 0 ? "#00FFA3" : "#FF2D55" },
          { label: "Rejected", text: scoreText(r.score.rejected), color: "#94A3B8" },
        );
        return values;
      },
      destroy() {
        wt1.detachPrimitive(tint);
        wt1.detachPrimitive(markers);
      },
    };
  },
};
