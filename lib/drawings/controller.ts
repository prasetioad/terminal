import type { IChartApi, ISeriesApi, Logical } from "lightweight-charts";
import { CanvasPrimitive, type DrawScope } from "../chart/CanvasPrimitive";
import { logicalToTime, logicalToX, timeToLogical } from "../chart/timeAxis";
import { loadJson, saveJson } from "../storage";
import type { Candle } from "../types";
import { hitDrawing, isSimpleDrawing, paintDrawing, type Hit, type Point, type Projector } from "./geometry";
import { measureLines, measureStats, paintMeasure, type Measurement } from "./measure";
import {
  hitPosition,
  isLevelKey,
  isPositionDrawing,
  isPositionTool,
  levelsOf,
  movePositionHandle,
  newPosition,
  paintPosition,
  positionBox,
  positionFields,
  positionSettings,
  positionStatRows,
  positionStats,
  setPositionLevel,
  type PositionTool,
} from "./position";
import {
  PROFILE_FIELDS,
  hitProfile,
  isProfileDrawing,
  paintPendingProfile,
  paintProfile,
  profileBox,
  profileSettings,
  profileStatRows,
  rangeOf,
  rangeProfile,
  type ProfileBox,
  type ProfileDrawing,
  type RangeProfile,
} from "./profiles";
import { RangeCandleStore, type RangeCandles } from "./rangeData";
import {
  DRAWING_COLORS,
  LINE_WIDTHS,
  MEASURE_TOOL,
  TOOLS,
  isDrawingList,
  pointsFor,
  type ActiveTool,
  type Anchor,
  type Drawing,
  type DrawingOptionValue,
  type DrawingOptions,
  type DrawingTool,
  type DrawingsSnapshot,
  type SettingField,
  type StatRow,
  lineWidthOf,
  toolDef,
} from "./types";

const STORAGE_PREFIX = "orderflow-terminal:drawings:v1:";
const DEFAULT_COLOR: Record<DrawingTool, string> = {
  trendline: DRAWING_COLORS[0],
  hline: DRAWING_COLORS[1],
  rectangle: DRAWING_COLORS[4],
  fib: DRAWING_COLORS[5],
  profile: DRAWING_COLORS[2], // POC in red, like TradingView
  flowProfile: DRAWING_COLORS[1],
  longPosition: DRAWING_COLORS[5], // the entry line; the zones are green / red
  shortPosition: DRAWING_COLORS[5],
};
const CLICK_SLOP_PX = 4; // below this, press-and-release counts as a click
const MAGNET_PX = 14;
/** A new position: the stop this far from the entry (target at 2R), lasting POSITION_BARS. */
const POSITION_STOP_PX = 40;
const POSITION_BARS = 20;
const MAX_HISTORY = 100;

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
  /** Drawing under the pointer (positions show their stats on hover, as in TradingView). */
  private hoveredId: string | null = null;
  private magnet = false;
  private hidden = false;
  private draft: Draft | null = null;
  private drag: Drag | null = null;
  /** A pointer gesture we claimed from the chart is in progress. */
  private gesture = false;
  private symbol: string | null = null;

  /**
   * Undo / redo of the current symbol's drawings: each edit pushes the state it
   * replaced. `committed` is the last recorded state, so in-place changes (a drag
   * mutates points as it moves) are undone as one step.
   */
  private committed: Drawing[] = [];
  private undoStack: Drawing[][] = [];
  private redoStack: Drawing[][] = [];

  private candles: readonly Candle[] = [];
  private intervalMs = 60_000;
  private precision = 2;
  private minMove = 0.01;
  private attachment: Attachment | null = null;
  private readonly primitive = new CanvasPrimitive((scope) => this.paint(scope), "top");

  /** Klines behind range profiles (their own resolution, independent of the chart's). */
  private readonly rangeData = new RangeCandleStore(() => this.publish()); // new data: repaint, refresh the inspector
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

  setData(candles: readonly Candle[], intervalMs: number, precision: number, minMove: number): void {
    this.candles = candles;
    this.intervalMs = intervalMs;
    this.precision = precision;
    this.minMove = minMove;
    // A selected position's figures follow the price.
    const selected = this.selected();
    if (selected && isPositionDrawing(selected) && JSON.stringify(this.statsOf(selected)) !== JSON.stringify(this.snapshot.selectedStats)) {
      this.publish();
    } else {
      this.primitive.refresh();
    }
  }

  /** Switch to another symbol's drawings. */
  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    this.rangeData.setSymbol(symbol);
    this.profileCache.clear();
    this.drawings = loadJson(STORAGE_PREFIX + symbol, isDrawingList) ?? [];
    this.committed = structuredClone(this.drawings);
    this.undoStack = [];
    this.redoStack = [];
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
    if (!d || d.color === color) return;
    d.color = color;
    this.changed(true);
  }

  setLineWidth(width: number): void {
    const d = this.selected();
    if (!d || !LINE_WIDTHS.some((w) => w === width) || lineWidthOf(d) === width) return;
    d.lineWidth = width;
    this.changed(true);
  }

  /** Set a setting of the selected drawing: a tool option (e.g. a profile's rows) or a position's level. */
  setOption(key: string, value: DrawingOptionValue): void {
    const d = this.selected();
    if (d && isPositionDrawing(d) && isLevelKey(key)) {
      if (typeof value !== "number" || !(value > 0) || value === levelsOf(d)[key]) return;
      d.points = this.onTicks(setPositionLevel(d, key, value, this.minMove, this.intervalMs));
      this.changed(true);
      return;
    }
    if (!d || d.options?.[key] === value) return;
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
    if (this.drawings.length === 0) return;
    this.drawings = [];
    this.selectedId = null;
    this.draft = null;
    this.changed(true);
  }

  undo(): void {
    this.restore(this.undoStack, this.redoStack);
  }

  redo(): void {
    this.restore(this.redoStack, this.undoStack);
  }

  /** Step through history: bring back the newest state of `from`, keeping the current one in `to`. */
  private restore(from: Drawing[][], to: Drawing[][]): void {
    // An unfinished placement or drag is abandoned rather than recorded.
    this.draft = null;
    this.drag = null;
    const state = from.pop();
    if (state) {
      to.push(this.committed);
      this.committed = state;
      this.drawings = structuredClone(state);
      if (!this.drawings.some((d) => d.id === this.selectedId)) this.selectedId = null;
      this.persist();
    }
    this.changed();
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
        points: isPositionTool(tool)
          ? this.newPositionPoints(tool, hit.anchor, hit.logical, p)
          : Array.from({ length: pointsFor(tool) }, () => ({ ...hit.anchor })),
        color: DEFAULT_COLOR[tool],
      };
      this.draft = { drawing, start: p, awaitingSecondClick: false };
      if (toolDef(tool).place === "click") this.commitDraft();
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
    if ((hover?.id ?? null) !== this.hoveredId) {
      this.hoveredId = hover?.id ?? null;
      this.primitive.refresh();
    }
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
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      // Ctrl/⌘+Z undo; Ctrl/⌘+Shift+Z or Ctrl/⌘+Y redo.
      const key = e.key.toLowerCase();
      if (key === "z" || (key === "y" && !e.shiftKey)) {
        e.preventDefault();
        if (key === "y" || e.shiftKey) this.redo();
        else this.undo();
        return;
      }
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
      if (isPositionDrawing(d)) {
        d.points = this.onTicks(movePositionHandle(d, drag.handle, hit.anchor, this.minMove, this.intervalMs));
      } else {
        d.points[drag.handle] = hit.anchor;
      }
    } else {
      const at = this.anchorAt(p, false);
      if (!at) return;
      const dLogical = at.logical - drag.start.logical;
      const dPrice = at.anchor.price - drag.start.price;
      const moved = drag.origin.map((o) => {
        const logical = timeToLogical(this.candles, this.intervalMs, o.time);
        const time = logical === null ? null : logicalToTime(this.candles, this.intervalMs, logical + dLogical);
        return { time: time ?? o.time, price: o.price + dPrice };
      });
      d.points = isPositionDrawing(d) ? this.onTicks(moved) : moved;
    }
    drag.moved = true;
    this.primitive.refresh();
  }

  /* ───────────────────────────── positions ───────────────────────────── */

  private toTick(price: number): number {
    const decimals = Math.max(0, this.precision);
    return Number((Math.round(price / this.minMove) * this.minMove).toFixed(decimals));
  }

  /** Position prices sit on the pair's tick grid (and carry no float noise). */
  private onTicks(points: Anchor[]): Anchor[] {
    return points.map((a) => ({ ...a, price: this.toTick(a.price) }));
  }

  /** Entry at the click (on a tick), stop POSITION_STOP_PX away, POSITION_BARS long. */
  private newPositionPoints(tool: PositionTool, at: Anchor, logical: number, p: Point): Anchor[] {
    const entry = this.toTick(at.price);
    const away = this.attachment?.series.coordinateToPrice(p.y + POSITION_STOP_PX);
    const risk = Math.max(this.minMove, this.toTick(Math.abs(entry - (away ?? entry * 0.99))));
    const end = logicalToTime(this.candles, this.intervalMs, logical + POSITION_BARS) ?? at.time + POSITION_BARS * this.intervalMs;
    return this.onTicks(newPosition(tool, { time: at.time, price: entry }, risk, end - at.time));
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

  /** The range's data (loading it if needed) and its profile, rebuilt only when an input changed. */
  private rangeProfileOf(d: ProfileDrawing): { data: RangeCandles; profile: RangeProfile | null } {
    const [from, to] = rangeOf(d);
    const data = this.rangeData.get(from, to);
    const key = `${from}|${to}|${data.status}|${this.rangeData.version}|${this.minMove}|${JSON.stringify(profileSettings(d))}`;
    const hit = this.profileCache.get(d.id);
    if (hit?.key === key) return { data, profile: hit.profile };
    const profile = rangeProfile(data, d, this.minMove);
    this.profileCache.set(d.id, { key, profile });
    return { data, profile };
  }

  private boxOf(d: ProfileDrawing, proj: Projector): ProfileBox | null {
    return profileBox(d, this.rangeProfileOf(d).profile, proj);
  }

  /** Top-most drawing under (x, y); the selected drawing's handles win over everything. */
  private hitAt(x: number, y: number): Hit | null {
    const proj = this.projectorFor();
    const test = (d: Drawing, withHandles: boolean) => {
      if (isSimpleDrawing(d)) return hitDrawing(d, proj, x, y, withHandles);
      if (isPositionDrawing(d)) {
        const box = positionBox(d, proj);
        return box ? hitPosition(box, x, y, withHandles) : null;
      }
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
    if (isPositionDrawing(d)) {
      const box = positionBox(d, proj);
      if (!box) return;
      const series = this.attachment?.series;
      const timeScale = this.attachment?.chart.timeScale();
      const show = positionSettings(d).alwaysStats || selected || d.id === this.hoveredId;
      paintPosition(scope.ctx, d, box, positionStats(d, this.candles), show, selected, {
        precision: this.precision,
        base: this.baseAsset(),
        xAt: (ms) => {
          const logical = timeToLogical(this.candles, this.intervalMs, ms);
          return logical === null || !timeScale ? null : logicalToX(timeScale, logical);
        },
        yAt: (price) => series?.priceToCoordinate(price) ?? null,
      });
      return;
    }
    if (!isProfileDrawing(d)) return;
    const { data, profile } = this.rangeProfileOf(d);
    const box = profileBox(d, profile, proj);
    if (!box) return;
    if (!profile) {
      const note = data.status === "loading" ? "Loading volume…" : data.status === "error" ? "Volume data unavailable" : "No trades in range";
      paintPendingProfile(scope.ctx, d, box, note, selected);
      return;
    }
    const base = this.baseAsset();
    paintProfile(scope.ctx, d, profile, box, selected, {
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

  private baseAsset(): string {
    return this.symbol?.replace(/USDT$/, "") ?? "";
  }

  /** Effective settings (defaults filled in; a position's levels included), for the inspector. */
  private optionsOf(d: Drawing): DrawingOptions | null {
    if (isProfileDrawing(d)) return { ...profileSettings(d) };
    if (isPositionDrawing(d)) {
      const { entry, target, stop } = levelsOf(d);
      return { ...positionSettings(d), entry, target, stop };
    }
    return d.options ?? null;
  }

  private fieldsOf(d: Drawing): readonly SettingField[] | null {
    if (isProfileDrawing(d)) return PROFILE_FIELDS[d.tool];
    if (isPositionDrawing(d)) return positionFields(this.minMove);
    return null;
  }

  private statsOf(d: Drawing): StatRow[] | null {
    if (isProfileDrawing(d)) {
      const rp = this.rangeProfileOf(d).profile;
      return rp ? profileStatRows(rp, this.precision) : null;
    }
    if (isPositionDrawing(d)) return positionStatRows(positionStats(d, this.candles), this.baseAsset(), positionSettings(d));
    return null;
  }

  private buildSnapshot(): DrawingsSnapshot {
    const selected = this.selected();
    return {
      tool: this.tool,
      selectedId: this.selectedId,
      selectedTool: selected?.tool ?? null,
      selectedColor: selected?.color ?? null,
      selectedLineWidth: selected ? lineWidthOf(selected) : null,
      selectedOptions: selected ? this.optionsOf(selected) : null,
      selectedFields: selected ? this.fieldsOf(selected) : null,
      selectedStats: selected ? this.statsOf(selected) : null,
      magnet: this.magnet,
      hidden: this.hidden,
      count: this.drawings.length,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  /**
   * Publish a new snapshot and repaint. `edit`: the drawings themselves changed by a
   * user action, so the change is recorded for undo and saved.
   */
  private changed(edit = false): void {
    if (edit) this.recordEdit();
    this.syncChartInteraction();
    if (this.attachment && !this.tool && !this.drag) this.attachment.container.style.cursor = "";
    this.publish();
  }

  /** New snapshot for React and a repaint; no side effects on the pointer or the chart. */
  private publish(): void {
    this.snapshot = this.buildSnapshot();
    this.primitive.refresh();
    for (const listener of this.listeners) listener();
  }

  private recordEdit(): void {
    this.undoStack.push(this.committed);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.committed = structuredClone(this.drawings);
    this.persist();
  }

  private persist(): void {
    if (this.symbol) saveJson(STORAGE_PREFIX + this.symbol, this.drawings);
  }
}
