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
import { computeMaxFlow, type DivergenceKind, type DotKind, type MaxFlowResult } from "../maxflow";
import { updateSeriesFrom, visibleBars } from "./common";
import type { IndicatorData, IndicatorDefinition, IndicatorParams, LegendValue } from "./types";

const HTF_OPTIONS = [
  { value: "15m", label: "15 minutes", ms: 900_000 },
  { value: "1h", label: "1 hour", ms: 3_600_000 },
  { value: "4h", label: "4 hours", ms: 14_400_000 },
  { value: "1d", label: "1 day", ms: 86_400_000 },
] as const;

// TradingView's named colours, as the script uses them.
const COLORS = {
  wt1: "#FFEB3B",
  wt2: "#1D4ED8",
  limit: "rgba(168, 85, 247, 0.6)",
  poc: "rgba(255, 152, 0, 0.7)",
  mfUp: "rgba(34, 197, 94, 0.75)",
  mfDown: "rgba(239, 68, 68, 0.8)",
  vwap: "rgba(229, 231, 235, 0.65)",
  zero: "rgba(255, 255, 255, 0.3)",
  tintBull: "rgba(76, 175, 80, 0.07)",
  tintBear: "rgba(242, 54, 69, 0.07)",
};

// Main dots (linewidth=4 in the script) are drawn larger than early dots (linewidth=1).
const DOT_STYLE: Record<DotKind, { color: string; radius: number }> = {
  red: { color: "#F23645", radius: 3.5 },
  green: { color: "#00E676", radius: 3.5 },
  earlyRed: { color: "rgba(255, 152, 0, 0.8)", radius: 2 },
  earlyGreen: { color: "rgba(0, 188, 212, 0.8)", radius: 2 },
};

const DIVERGENCE_STYLE: Record<DivergenceKind, { color: string; up: boolean }> = {
  regularBull: { color: "#00E676", up: true },
  hiddenBull: { color: "rgba(0, 230, 118, 0.5)", up: true },
  regularBear: { color: "#F23645", up: false },
  hiddenBear: { color: "rgba(242, 54, 69, 0.5)", up: false },
};

const TRIANGLE = 5; // half width, px

const optionsOf = (p: IndicatorParams, intervalMs: number) => ({
  scalping: p.mode === "scalping",
  obosFilter: Boolean(p.obosFilter),
  divergence: Boolean(p.divergence),
  hiddenDivergence: Boolean(p.hiddenDivergence),
  mtf: Boolean(p.mtf),
  htfMs: HTF_OPTIONS.find((o) => o.value === p.htf)?.ms ?? 3_600_000,
  intervalMs,
  dynamicBands: Boolean(p.dynamicBands),
  atrLength: Number(p.atrLength),
  volumeArea: Boolean(p.volumeArea),
  earlyWarning: Boolean(p.earlyWarning),
  mfLength: Number(p.mfLength),
  mfSmooth: Number(p.mfSmooth),
  vwapLength: Number(p.vwapLength),
});

export const maxFlowIndicator: IndicatorDefinition = {
  type: "maxflow",
  name: "MaxFlow+ Ultimate",
  description:
    "WaveTrend columns with OB/OS limits, money flow, a VWAP wave and red/green signal dots — plus auto divergence, a higher-timeframe trend bias, ATR-scaled limits, a money-flow POC level and early-warning dots.",
  category: "Oscillator",
  placement: "pane",
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
    { key: "obosFilter", label: "Filter dots by OB/OS levels", type: "boolean", default: true },
    { key: "divergence", label: "Auto divergence", type: "boolean", default: true },
    { key: "hiddenDivergence", label: "└ Include hidden divergence", type: "boolean", default: true },
    { key: "mtf", label: "Higher-timeframe trend bias", type: "boolean", default: true },
    {
      key: "htf",
      label: "└ Higher timeframe",
      type: "select",
      default: "1h",
      options: HTF_OPTIONS.map(({ value, label }) => ({ value, label })),
    },
    { key: "dynamicBands", label: "Dynamic volatility bands (ATR)", type: "boolean", default: false },
    { key: "atrLength", label: "└ ATR length", type: "number", default: 14, min: 1, max: 100, step: 1 },
    { key: "volumeArea", label: "Volume area & POC level", type: "boolean", default: true },
    { key: "earlyWarning", label: "Early-warning dots", type: "boolean", default: true },
    { key: "mfLength", label: "Money flow length", type: "number", default: 14, min: 2, max: 100, step: 1 },
    { key: "mfSmooth", label: "Money flow smoothing", type: "number", default: 3, min: 1, max: 20, step: 1 },
    { key: "vwapLength", label: "VWAP oscillator length", type: "number", default: 8, min: 1, max: 50, step: 1 },
  ],
  summary: (p) => {
    const mode = p.mode === "scalping" ? "Scalping" : "Swing";
    return p.mtf ? `${mode} · HTF ${p.htf}` : mode;
  },

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    let visible = true;
    let data: IndicatorData | null = null;
    let result: MaxFlowResult | null = null;

    // Added in the script's plot order, which is also the drawing order.
    const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    const upper = ctx.addSeries(LineSeries, { ...quiet, color: COLORS.limit, lineWidth: 1 });
    const lower = ctx.addSeries(LineSeries, { ...quiet, color: COLORS.limit, lineWidth: 1 });
    const poc = ctx.addSeries(LineSeries, { ...quiet, color: COLORS.poc, lineWidth: 1 });
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
    const moneyFlow = area(COLORS.mfUp, COLORS.mfDown);
    const vwap = area(COLORS.vwap, COLORS.vwap);
    wt1.createPriceLine({ price: 0, color: COLORS.zero, lineStyle: LineStyle.Solid, lineWidth: 1, axisLabelVisible: false });

    const plots: [ISeriesApi<SeriesType>, (r: MaxFlowResult) => Float64Array][] = [
      [upper, (r) => r.devUpper],
      [lower, (r) => r.devLower],
      [poc, (r) => r.poc],
      [wt1, (r) => r.wt1],
      [wt2, (r) => r.wt2],
      [moneyFlow, (r) => r.moneyFlow],
      [vwap, (r) => r.vwapOsc],
    ];

    const point = (d: IndicatorData, values: Float64Array, i: number): { time: Time; value: number } | WhitespaceData<Time> => {
      const time = d.candles[i].time;
      return Number.isNaN(values[i]) ? { time } : { time, value: values[i] };
    };

    const applyVisibility = () => {
      // As in the script, "Volume Area & POC" only switches the POC line; money flow always shows.
      for (const [series] of plots) series.applyOptions({ visible: visible && (series !== poc || Boolean(params.volumeArea)) });
      tint.refresh();
      markers.refresh();
    };

    /** x of bar `i` and the width of one bar, in pane pixels. */
    const barGeometry = (scope: DrawScope, i: number) => {
      const ts = scope.chart.timeScale();
      const x = ts.logicalToCoordinate(i as Logical);
      const next = ts.logicalToCoordinate((i + 1) as Logical);
      return x === null ? null : { x, width: next === null ? 6 : next - x };
    };

    /** Higher-timeframe bias as a faint background, merged into runs of equal colour. */
    const paintTint = (scope: DrawScope) => {
      if (!visible || !params.mtf || !data || !result) return;
      const bars = visibleBars(scope, data);
      if (!bars) return;
      const { htfBias } = result;
      let start = bars.from;
      for (let i = bars.from; i <= bars.to + 1; i++) {
        if (i <= bars.to && htfBias[i] === htfBias[start]) continue;
        const bias = htfBias[start];
        const a = barGeometry(scope, start);
        const b = barGeometry(scope, i - 1);
        if (bias !== 0 && a && b) {
          scope.ctx.fillStyle = bias > 0 ? COLORS.tintBull : COLORS.tintBear;
          const left = a.x - a.width / 2;
          scope.ctx.fillRect(left, 0, b.x + b.width / 2 - left, scope.height);
        }
        start = i;
      }
    };

    const paintMarkers = (scope: DrawScope) => {
      if (!visible || !data || !result) return;
      const bars = visibleBars(scope, data);
      if (!bars) return;
      const { ctx: g, series } = scope;
      const inView = <M extends { index: number }>(m: M) => m.index >= bars.from && m.index <= bars.to;

      for (const dot of result.dots.filter(inView)) {
        const x = scope.chart.timeScale().logicalToCoordinate(dot.index as Logical);
        const y = series.priceToCoordinate(dot.value);
        if (x === null || y === null) continue;
        const style = DOT_STYLE[dot.kind];
        g.beginPath();
        g.arc(x, y, style.radius, 0, Math.PI * 2);
        g.fillStyle = style.color;
        g.fill();
      }
      for (const div of result.divergences.filter(inView)) {
        const x = scope.chart.timeScale().logicalToCoordinate(div.index as Logical);
        const y = series.priceToCoordinate(div.value);
        if (x === null || y === null) continue;
        const { color, up } = DIVERGENCE_STYLE[div.kind];
        const tip = up ? -TRIANGLE : TRIANGLE;
        g.beginPath();
        g.moveTo(x, y + tip);
        g.lineTo(x - TRIANGLE, y - tip);
        g.lineTo(x + TRIANGLE, y - tip);
        g.closePath();
        g.fillStyle = color;
        g.fill();
      }
    };

    const tint = new CanvasPrimitive(paintTint, "background");
    const markers = new CanvasPrimitive(paintMarkers, "top");
    wt1.attachPrimitive(tint);
    wt1.attachPrimitive(markers);
    applyVisibility();

    const recompute = (d: IndicatorData) => {
      data = d;
      result = computeMaxFlow(d.candles, optionsOf(params, d.intervalMs));
      return result;
    };

    return {
      render(d) {
        const r = recompute(d);
        for (const [series, values] of plots) {
          series.setData(d.candles.map((_, i) => point(d, values(r), i)));
        }
        tint.refresh();
        markers.refresh();
      },
      update(d, from) {
        // Recomputing is O(bars) and cheap; every series is causal, so only bars ≥ from changed.
        // Dots (offset −1) and divergences (confirmed a few bars later) live in the primitive.
        const r = recompute(d);
        for (const [series, values] of plots) {
          updateSeriesFrom(series, d.candles.length, from, (i) => point(d, values(r), i));
        }
        markers.refresh();
        tint.refresh();
      },
      setParams(next) {
        params = next;
        applyVisibility();
      },
      setVisible(next) {
        visible = next;
        applyVisibility();
      },
      legend(_d, index): LegendValue[] {
        // The candle array is shared and grows as soon as a new bar opens, before the next
        // update recomputes `result`: an index past its arrays reads undefined, not NaN.
        const r = result;
        const w1 = r?.wt1[index];
        if (!r || w1 === undefined || !Number.isFinite(w1)) return [];
        const values: LegendValue[] = [{ label: "WT", text: w1.toFixed(1), color: COLORS.wt1 }];
        const w2 = r.wt2[index];
        if (Number.isFinite(w2)) values.push({ text: w2.toFixed(1), color: "#60A5FA" });
        const mf = r.moneyFlow[index];
        if (Number.isFinite(mf)) values.push({ label: "MF", text: mf.toFixed(1), color: mf >= 0 ? "#22C55E" : "#EF4444" });
        if (params.mtf && r.htfBias[index] !== 0) {
          const bull = r.htfBias[index] > 0;
          values.push({ label: "HTF", text: bull ? "▲ Bull" : "▼ Bear", color: bull ? "#22C55E" : "#EF4444" });
        }
        return values;
      },
      destroy() {
        wt1.detachPrimitive(tint);
        wt1.detachPrimitive(markers);
      },
    };
  },
};
