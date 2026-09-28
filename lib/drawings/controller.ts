import type { IChartApi, ISeriesApi, Logical } from "lightweight-charts";
import { CanvasPrimitive, type DrawScope } from "../chart/CanvasPrimitive";
import { logicalToTime, logicalToX, timeToLogical } from "../chart/timeAxis";
import { loadJson, saveJson } from "../storage";
import type { Candle } from "../types";
import { hitDrawing, isSimpleDrawing, paintDrawing, type Hit, type Point, type Projector } from "./geometry";
import { measureLines, measureStats, paintMeasure, type Measurement } from "./measure";
import {
  hitProfile,
  isProfileDrawing,
  paintProfile,
  profileBox,
  profileOptions,
  rangeProfile,
  type ProfileBox,
  type ProfileDrawing,
  type RangeProfile,
} from "./profiles";
import {
  DRAWING_COLORS,
  MEASURE_TOOL,
  TOOLS,
  isDrawingList,
  pointsFor,
  type ActiveTool,
  type Anchor,
  type Drawing,
  type DrawingOptions,
  type DrawingTool,
  type DrawingsSnapshot,
} from "./types";

const STORAGE_PREFIX = "orderflow-terminal:drawings:v1:";
const DEFAULT_COLOR: Record<DrawingTool, string> = {
  trendline: DRAWING_COLORS[0],
  hline: DRAWING_COLORS[1],
  rectangle: DRAWING_COLORS[4],
  fib: DRAWING_COLORS[5],
  profile: DRAWING_COLORS[2], // POC in red, like TradingView
  flowProfile: DRAWING_COLORS[1],
};
const CLICK_SLOP_PX = 4; // below this, press-and-release counts as a click
const MAGNET_PX = 14;

interface Attachment {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  container: HTMLElement;
}

interface Draft {
  drawing: Drawing;
  start: Point;
  /** True once the first press was released without dragging: the next click sets the end point. */
  awaitingSecondClick: boolean;
}

interface Drag {
  id: string;
  handle: number | null; // null = move the whole drawing
  start: { logical: number; price: number };
  origin: Anchor[];
  moved: boolean;
}

/**
 * Owns the drawings of the current symbol: placement, selection, dragging, styling,
 * keyboard shortcuts and persistence, plus the temporary measure tool. Renders through
 * one canvas primitive on the price pane. React subscribes to a small snapshot.
 */
export class DrawingController {
  private drawings: Drawing[] = [];
  private tool: ActiveTool | null = null;
  private measurement: Measurement | null = null;
  private selectedId: string | null = null;
  private magnet = false;
  private hidden = false;
  private draft: Draft | null = null;
  private drag: Drag | null = null;
  /** A pointer gesture we claimed from the chart is in progress. */
  private gesture = false;
  private symbol: string | null = null;

  private candles: readonly Candle[] = [];
  private intervalMs = 60_000;
  private precision = 2;
  private attachment: Attachment | null = null;
  private readonly primitive = new CanvasPrimitive((scope) => this.paint(scope), "top");

  /** Range profiles by drawing id, recomputed only when their inputs change. */
  private profileCache = new Map<string, { key: string; profile: RangeProfile | null }>();

  private readonly listeners = new Set<() => void>();
  private snapshot: DrawingsSnapshot = this.buildSnapshot();

  /* ───────────────────────────── wiring ───────────────────────────── */

  attach(chart: IChartApi, series: ISeriesApi<"Candlestick">, container: HTMLElement): void {
    this.attachment = { chart, series, container };
    series.attachPrimitive(this.primitive);
    // Capture phase: decide before the chart sees the event whether it is ours.
    container.addEventListener("pointerdown", this.onPointerDown, true);
    container.addEventListener("pointermove", this.onPointerMove, true);
    container.addEventListener("pointerup", this.onPointerUp, true);
    container.addEventListener("pointercancel", this.onPointerUp, true);
    window.addEventListener("keydown", this.onKeyDown);
  }

  detach(): void {
    const a = this.attachment;
    if (!a) return;
    a.container.removeEventListener("pointerdown", this.onPointerDown, true);
    a.container.removeEventListener("pointermove", this.onPointerMove, true);
    a.container.removeEventListener("pointerup", this.onPointerUp, true);
    a.container.removeEventListener("pointercancel", this.onPointerUp, true);
    window.removeEventListener("keydown", this.onKeyDown);
    a.series.detachPrimitive(this.primitive);
    this.attachment = null;
    this.draft = null;
    this.drag = null;
  }

  setData(candles: readonly Candle[], intervalMs: number, precision: number): void {
    if (candles !== this.candles) this.profileCache.clear(); // new dataset
    this.candles = candles;
    this.intervalMs = intervalMs;
    this.precision = precision;
    this.primitive.refresh();
  }

  /** Switch to another symbol's drawings. */
  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    this.drawings = loadJson(STORAGE_PREFIX + symbol, isDrawingList) ?? [];
    this.selectedId = null;
    this.measurement = null;
    this.draft = null;
    this.drag = null;
    this.changed();
  }

  /* ─────────────────────────── React bridge ─────────────────────────── */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DrawingsSnapshot => this.snapshot;

  /* ───────────────────────────── actions ───────────────────────────── */

  setTool(tool: ActiveTool | null): void {
    this.tool = tool;
    this.draft = null;
    this.measurement = null;
    if (tool) this.selectedId = null;
    this.changed();
  }

  toggleMagnet(): void {
    this.magnet = !this.magnet;
    this.changed();
  }

  toggleHidden(): void {
    this.hidden = !this.hidden;
    if (this.hidden) this.selectedId = null;
    this.changed();
  }

  setColor(color: string): void {
    const d = this.selected();
    if (!d) return;
    d.color = color;
    this.changed(true);
  }

  /** Set a tool-specific option (e.g. a profile's rows) on the selected drawing. */
  setOption(key: string, value: number | boolean): void {
    const d = this.selected();
    if (!d) return;
    d.options = { ...d.options, [key]: value };
    this.changed(true);
  }

  deleteSelected(): void {
    if (!this.selectedId) return;
    this.drawings = this.drawings.filter((d) => d.id !== this.selectedId);
    this.selectedId = null;
    this.changed(true);
  }

  clearAll(): void {
    this.drawings = [];
    this.selectedId = null;
    this.draft = null;
    this.changed(true);
  }

  /* ─────────────────────────── coordinates ─────────────────────────── */

  private readonly toPoint = (anchor: Anchor): Point | null => {
    const a = this.attachment;
    if (!a) return null;
    const logical = timeToLogical(this.candles, this.intervalMs, anchor.time);
    if (logical === null) return null;
    const x = logicalToX(a.chart.timeScale(), logical);
    const y = a.series.priceToCoordinate(anchor.price);
    return x === null || y === null ? null : { x, y };
  };

  private projectorFor(width = this.attachment?.chart.timeScale().width() ?? 0): Projector {
    return { toPoint: this.toPoint, width };
  }

  /** Fractional bar index under x (the chart API rounds, so interpolate from bar spacing). */
  private logicalAt(x: number): number | null {
    const ts = this.attachment?.chart.timeScale();
    const approx = ts?.coordinateToLogical(x);
    if (!ts || approx === null || approx === undefined) return null;
    const base = Math.round(approx);
    const bx = ts.logicalToCoordinate(base as Logical);
    const nx = ts.logicalToCoordinate((base + 1) as Logical);
    if (bx === null || nx === null || nx === bx) return base;
    return base + (x - bx) / (nx - bx);
  }

  private anchorAt(p: Point, snap: boolean): { anchor: Anchor; logical: number } | null {
    const a = this.attachment;
    const logical = this.logicalAt(p.x);
    const price = a?.series.coordinateToPrice(p.y);
    if (!a || logical === null || price === null || price === undefined) return null;

    if (snap && this.magnet && this.candles.length > 0) {
      const i = Math.min(this.candles.length - 1, Math.max(0, Math.round(logical)));
      const c = this.candles[i];
      let best: { price: number; dist: number } | null = null;
      for (const level of [c.open, c.high, c.low, c.close]) {
        const y = a.series.priceToCoordinate(level);
        if (y === null) continue;
        const dist = Math.abs(y - p.y);
        if (dist <= MAGNET_PX && (!best || dist < best.dist)) best = { price: level, dist };
      }
      if (best) return { anchor: { time: c.time * 1000, price: best.price }, logical: i };
    }
    const time = logicalToTime(this.candles, this.intervalMs, logical);
    return time === null ? null : { anchor: { time, price }, logical };
  }

  /** Pointer position relative to the chart, if it is inside the price pane. */
  private pointInPricePane(e: PointerEvent): Point | null {
    const a = this.attachment;
    if (!a) return null;
    const rect = a.container.getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const paneHeight = a.chart.panes()[0]?.getHeight() ?? 0;
    const paneWidth = a.chart.timeScale().width();
    return p.x >= 0 && p.x <= paneWidth && p.y >= 0 && p.y <= paneHeight ? p : null;
  }

  /* ─────────────────────────── interaction ─────────────────────────── */

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.attachment) return;
    const p = this.pointInPricePane(e);
    if (!p) return;

    // Measure: the armed tool or Shift+drag starts one; a click ends a click-click measurement.
    if (this.measurement?.phase === "awaiting") {
      this.claim(e);
      this.updateMeasurement(p);
      this.finishMeasurement();
      return;
    }
    if (this.tool === "measure" || (!this.tool && e.shiftKey)) {
      this.claim(e);
      this.startMeasurement(p);
      return;
    }
    if (this.measurement) this.clearMeasurement(); // a finished measurement goes away on the next click

    const tool = this.tool;
    if (tool) {
      this.claim(e);
      if (this.draft?.awaitingSecondClick) {
        this.updateDraft(p);
        this.commitDraft();
        return;
      }
      const hit = this.anchorAt(p, true);
      if (!hit) return;
      const drawing: Drawing = {
        id: crypto.randomUUID(),
        tool,
        points: Array.from({ length: pointsFor(tool) }, () => ({ ...hit.anchor })),
        color: DEFAULT_COLOR[tool],
      };
      this.draft = { drawing, start: p, awaitingSecondClick: false };
      if (pointsFor(tool) === 1) this.commitDraft();
      else this.primitive.refresh();
      return;
    }

    if (this.hidden) return;
    const hit = this.hitAt(p.x, p.y);
    if (!hit) {
      if (this.selectedId) {
        this.selectedId = null;
        this.changed();
      }
      return; // let the chart pan
    }
    this.claim(e);
    const at = this.anchorAt(p, false);
    const d = this.drawings.find((x) => x.id === hit.id);
    if (!at || !d) return;
    this.selectedId = hit.id;
    this.drag = {
      id: hit.id,
      handle: hit.handle,
      start: { logical: at.logical, price: at.anchor.price },
      origin: d.points.map((pt) => ({ ...pt })),
      moved: false,
    };
    this.changed();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const a = this.attachment;
    if (!a) return;
    const p = this.pointInPricePane(e) ?? this.clampedPoint(e);

    if (this.measurement && this.measurement.phase !== "done") {
      e.stopPropagation();
      this.updateMeasurement(p);
      return;
    }
    if (this.draft) {
      e.stopPropagation();
      this.updateDraft(p);
      return;
    }
    if (this.drag) {
      e.stopPropagation();
      this.updateDrag(p);
      return;
    }
    // Hover feedback only.
    const inside = this.pointInPricePane(e);
    const hover = inside && !this.hidden ? this.hitAt(inside.x, inside.y) : null;
    const crosshair = inside && (this.tool || e.shiftKey);
    a.container.style.cursor = crosshair ? "crosshair" : hover ? (hover.handle !== null ? "grab" : "move") : "";
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const m = this.measurement;
    if (m?.phase === "dragging") {
      const p = this.clampedPoint(e);
      if (Math.hypot(p.x - m.start.x, p.y - m.start.y) > CLICK_SLOP_PX) this.finishMeasurement();
      else m.phase = "awaiting"; // click-click measurement
    }
    if (this.draft && !this.draft.awaitingSecondClick) {
      const p = this.clampedPoint(e);
      const dragged = Math.hypot(p.x - this.draft.start.x, p.y - this.draft.start.y) > CLICK_SLOP_PX;
      if (dragged) this.commitDraft();
      else this.draft.awaitingSecondClick = true; // click-click placement
    }
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      if (moved) this.changed(true);
    }
    this.release(e);
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;

    if (e.key === "Escape") {
      if (this.draft || this.tool || this.measurement) this.setTool(null);
      else if (this.selectedId) {
        this.selectedId = null;
        this.changed();
      }
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selectedId) {
      e.preventDefault();
      this.deleteSelected();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const tool = e.code === `Key${MEASURE_TOOL.shortcut}` ? "measure" : TOOLS.find((t) => e.code === `Key${t.shortcut}`)?.tool;
      if (tool) {
        e.preventDefault();
        this.setTool(this.tool === tool ? null : tool);
      }
    }
  };

  /** Take the gesture away from the chart (no panning/zooming while we handle it). */
  private claim(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.gesture = true;
    this.attachment?.container.setPointerCapture(e.pointerId);
    this.syncChartInteraction();
  }

  private release(e: PointerEvent): void {
    const a = this.attachment;
    if (a?.container.hasPointerCapture(e.pointerId)) a.container.releasePointerCapture(e.pointerId);
    this.gesture = false;
    this.syncChartInteraction();
  }

  /**
   * The single rule for chart pan/zoom: off while we own a gesture or a placement or
   * measurement is in progress; panning also off while a tool is armed (clicks place points).
   */
  private syncChartInteraction(): void {
    const measuring = this.measurement !== null && this.measurement.phase !== "done";
    const busy = this.gesture || this.draft !== null || measuring;
    this.attachment?.chart.applyOptions({ handleScroll: !busy && !this.tool, handleScale: !busy });
  }

  private clampedPoint(e: PointerEvent): Point {
    const a = this.attachment!;
    const rect = a.container.getBoundingClientRect();
    const paneHeight = a.chart.panes()[0]?.getHeight() ?? rect.height;
    return {
      x: Math.min(Math.max(e.clientX - rect.left, 0), a.chart.timeScale().width()),
      y: Math.min(Math.max(e.clientY - rect.top, 0), paneHeight),
    };
  }

  private updateDraft(p: Point): void {
    const draft = this.draft;
    if (!draft) return;
    const hit = this.anchorAt(p, true);
    if (!hit) return;
    draft.drawing.points[draft.drawing.points.length - 1] = hit.anchor;
    this.primitive.refresh();
  }

  private commitDraft(): void {
    const draft = this.draft;
    if (!draft) return;
    this.draft = null;
    this.drawings.push(draft.drawing);
    this.selectedId = draft.drawing.id;
    this.tool = null; // back to the cursor after each drawing, like TradingView
    this.changed(true);
  }

  private updateDrag(p: Point): void {
    const drag = this.drag;
    const d = drag && this.drawings.find((x) => x.id === drag.id);
    if (!drag || !d) return;

    if (drag.handle !== null) {
      const hit = this.anchorAt(p, true);
      if (!hit) return;
      d.points[drag.handle] = hit.anchor;
    } else {
      const at = this.anchorAt(p, false);
      if (!at) return;
      const dLogical = at.logical - drag.start.logical;
      const dPrice = at.anchor.price - drag.start.price;
      d.points = drag.origin.map((o) => {
        const logical = timeToLogical(this.candles, this.intervalMs, o.time);
        const time = logical === null ? null : logicalToTime(this.candles, this.intervalMs, logical + dLogical);
        return { time: time ?? o.time, price: o.price + dPrice };
      });
    }
    drag.moved = true;
    this.primitive.refresh();
  }

  /* ───────────────────────────── measure ───────────────────────────── */

  private startMeasurement(p: Point): void {
    const hit = this.anchorAt(p, true);
    if (!hit) return;
    this.selectedId = null;
    this.measurement = { from: hit.anchor, to: { ...hit.anchor }, start: p, phase: "dragging" };
    this.changed();
  }

  private updateMeasurement(p: Point): void {
    const hit = this.measurement && this.anchorAt(p, true);
    if (!hit || !this.measurement) return;
    this.measurement.to = hit.anchor;
    this.primitive.refresh();
  }

  private finishMeasurement(): void {
    if (!this.measurement) return;
    this.measurement.phase = "done";
    this.tool = null; // back to the cursor; the result stays until the next click
    this.changed();
  }

  private clearMeasurement(): void {
    this.measurement = null;
    this.changed();
  }

  /* ───────────────────────────── painting ───────────────────────────── */

  /* ───────────────────── range profiles & hit testing ───────────────────── */

  private rangeProfileOf(d: ProfileDrawing): RangeProfile | null {
    const last = this.candles[this.candles.length - 1];
    const opts = profileOptions(d);
    const key = `${d.points[0].time}|${d.points[1].time}|${this.candles.length}|${last?.close}|${last?.volume}|${opts.rows}|${opts.valueArea}`;
    const hit = this.profileCache.get(d.id);
    if (hit?.key === key) return hit.profile;
    const profile = rangeProfile(this.candles, d);
    this.profileCache.set(d.id, { key, profile });
    return profile;
  }

  private boxOf(d: ProfileDrawing, proj: Projector): ProfileBox | null {
    const rp = this.rangeProfileOf(d);
    return rp ? profileBox(d, rp, proj) : null;
  }

  /** Top-most drawing under (x, y); the selected drawing's handles win over everything. */
  private hitAt(x: number, y: number): Hit | null {
    const proj = this.projectorFor();
    const test = (d: Drawing, withHandles: boolean) => {
      if (isSimpleDrawing(d)) return hitDrawing(d, proj, x, y, withHandles);
      if (!isProfileDrawing(d)) return null;
      const box = this.boxOf(d, proj);
      return box ? hitProfile(box, x, y, withHandles) : null;
    };
    const selected = this.selected();
    if (selected) {
      const r = test(selected, true);
      if (typeof r === "number") return { id: selected.id, handle: r };
    }
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      if (test(this.drawings[i], false) === "body") return { id: this.drawings[i].id, handle: null };
    }
    return null;
  }

  private paintOne(scope: DrawScope, d: Drawing, proj: Projector, selected: boolean): void {
    if (isSimpleDrawing(d)) {
      paintDrawing(scope.ctx, d, proj, selected, this.precision);
      return;
    }
    if (!isProfileDrawing(d)) return;
    const rp = this.rangeProfileOf(d);
    const box = rp && profileBox(d, rp, proj);
    if (!rp || !box) return;
    const base = this.symbol?.replace(/USDT$/, "") ?? "";
    paintProfile(scope.ctx, d, rp, box, selected, {
      paneWidth: scope.width,
      precision: this.precision,
      base,
    });
  }

  /* ───────────────────────────── painting ───────────────────────────── */

  private paint(scope: DrawScope): void {
    const proj = this.projectorFor(scope.width);
    if (!this.hidden) {
      for (const d of this.drawings) this.paintOne(scope, d, proj, d.id === this.selectedId);
    }
    if (this.draft) {
      this.profileCache.delete(this.draft.drawing.id); // the draft changes every move
      this.paintOne(scope, this.draft.drawing, proj, true);
    }
    const m = this.measurement;
    if (m) {
      const stats = measureStats(this.candles, this.intervalMs, m.from, m.to);
      const base = this.symbol?.replace(/USDT$/, "") ?? "";
      paintMeasure(scope.ctx, m, proj, scope.height, measureLines(stats, this.precision, base));
    }
  }

  /* ───────────────────────────── state ───────────────────────────── */

  private selected(): Drawing | undefined {
    return this.drawings.find((d) => d.id === this.selectedId);
  }

  /** Effective options (defaults filled in), for the inspector. */
  private optionsOf(d: Drawing): DrawingOptions | null {
    return isProfileDrawing(d) ? { ...profileOptions(d) } : (d.options ?? null);
  }

  private buildSnapshot(): DrawingsSnapshot {
    const selected = this.selected();
    return {
      tool: this.tool,
      selectedId: this.selectedId,
      selectedTool: selected?.tool ?? null,
      selectedColor: selected?.color ?? null,
      selectedOptions: selected ? this.optionsOf(selected) : null,
      magnet: this.magnet,
      hidden: this.hidden,
      count: this.drawings.length,
    };
  }

  /** Publish a new snapshot, repaint, and persist when the drawings themselves changed. */
  private changed(persist = false): void {
    if (persist && this.symbol) saveJson(STORAGE_PREFIX + this.symbol, this.drawings);
    this.syncChartInteraction();
    if (this.attachment && !this.tool && !this.drag) this.attachment.container.style.cursor = "";
    this.snapshot = this.buildSnapshot();
    this.primitive.refresh();
    for (const listener of this.listeners) listener();
  }
}
