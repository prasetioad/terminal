import { formatPrice, formatSigned } from "../format";
import { buildProfile, type VolumeProfile } from "../profile";
import type { Candle } from "../types";
import { crisp, type Hit, type Point, type Projector } from "./geometry";
import type { RangeCandles, Resolution } from "./rangeData";
import { lineWidthOf, type Drawing, type DrawingOptions, type DrawingTool, type SettingField, type StatRow } from "./types";

/**
 * Range profiles: drawings whose two points pick a time range; the volume profile of
 * that range is drawn inside it. Volume comes from klines at a resolution set by the
 * range's length (see rangeData.ts), so a profile doesn't change with the timeframe.
 *  - "profile":     TradingView's Fixed Range Volume Profile, with its settings:
 *                   rows / ticks per row, Up/Down · Total · Delta volume (up/down by
 *                   bar direction, as TradingView does), value area, width, placement,
 *                   values, VAH/VAL lines.
 *  - "flowProfile": orderflow profile for Fabio Valentini's approach — rows coloured by
 *                   aggressor (taker) delta, LVN zones / POC / VAH / VAL extended right
 *                   as trade levels, and the profile's shape (P / b / D).
 */
export type ProfileTool = Extract<DrawingTool, "profile" | "flowProfile">;

export type ProfileDrawing = Drawing & { tool: ProfileTool };

export const isProfileTool = (tool: DrawingTool): tool is ProfileTool => tool === "profile" || tool === "flowProfile";
export const isProfileDrawing = (d: Drawing): d is ProfileDrawing => isProfileTool(d.tool);

/* ───────────────────────────── settings ───────────────────────────── */

export type VolumeMode = "updown" | "total" | "delta";

export interface ProfileSettings {
  rowsLayout: "rows" | "ticks";
  /** Number of rows, or ticks per row. */
  rowSize: number;
  volume: VolumeMode;
  valueArea: number; // %
  width: number; // % of the range's width
  placement: "left" | "right";
  showValues: boolean;
  vaLines: boolean;
  extend: boolean; // key levels to the right edge
}

const DEFAULTS: Record<ProfileTool, ProfileSettings> = {
  // TradingView's Fixed Range Volume Profile defaults.
  profile: {
    rowsLayout: "rows",
    rowSize: 24,
    volume: "updown",
    valueArea: 70,
    width: 30,
    placement: "left",
    showValues: false,
    vaLines: false,
    extend: false,
  },
  flowProfile: {
    rowsLayout: "rows",
    rowSize: 48,
    volume: "delta",
    valueArea: 70,
    width: 45,
    placement: "left",
    showValues: false,
    vaLines: true,
    extend: true,
  },
};

const ROWS = { min: 4, max: 500 };
const TICKS = { min: 1, max: 100_000 };

export const PROFILE_FIELDS: Record<ProfileTool, readonly SettingField[]> = {
  profile: [
    {
      key: "rowsLayout",
      label: "Rows layout",
      type: "select",
      options: [
        { value: "rows", label: "Number of rows" },
        { value: "ticks", label: "Ticks per row" },
      ],
    },
    { key: "rowSize", label: "Row size", type: "number", min: 1, max: TICKS.max, step: 1 },
    {
      key: "volume",
      label: "Volume",
      type: "select",
      options: [
        { value: "updown", label: "Up/Down" },
        { value: "total", label: "Total" },
        { value: "delta", label: "Delta" },
      ],
    },
    { key: "valueArea", label: "Value area volume", type: "number", min: 1, max: 100, step: 1, suffix: "%" },
    { key: "width", label: "Width (% of box)", type: "number", min: 1, max: 100, step: 1, suffix: "%" },
    {
      key: "placement",
      label: "Placement",
      type: "select",
      options: [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ],
    },
    { key: "showValues", label: "Show values", type: "boolean" },
    { key: "vaLines", label: "Value area lines", type: "boolean" },
    { key: "extend", label: "Extend POC / VA right", type: "boolean" },
  ],
  flowProfile: [
    { key: "rowSize", label: "Rows", type: "number", min: ROWS.min, max: ROWS.max, step: 4 },
    { key: "valueArea", label: "Value area volume", type: "number", min: 50, max: 95, step: 5, suffix: "%" },
    { key: "width", label: "Width (% of box)", type: "number", min: 10, max: 100, step: 5, suffix: "%" },
    { key: "extend", label: "Extend levels right", type: "boolean" },
  ],
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** Effective settings: stored values, else the tool's defaults (older drawings stored `rows`). */
export function profileSettings(d: ProfileDrawing): ProfileSettings {
  const o: DrawingOptions = d.options ?? {};
  const base = DEFAULTS[d.tool];
  if (d.tool === "flowProfile") {
    return {
      ...base,
      rowSize: num(o.rowSize ?? o.rows, base.rowSize),
      valueArea: num(o.valueArea, base.valueArea),
      width: num(o.width, base.width),
      extend: bool(o.extend, base.extend),
    };
  }
  return {
    rowsLayout: pick(o.rowsLayout, ["rows", "ticks"], base.rowsLayout),
    rowSize: num(o.rowSize ?? o.rows, base.rowSize),
    volume: pick(o.volume, ["updown", "total", "delta"], base.volume),
    valueArea: num(o.valueArea, base.valueArea),
    width: num(o.width, base.width),
    placement: pick(o.placement, ["left", "right"], base.placement),
    showValues: bool(o.showValues, base.showValues),
    vaLines: bool(o.vaLines, base.vaLines),
    extend: bool(o.extend, base.extend),
  };
}

/* ───────────────────────────── the profile ───────────────────────────── */

export interface RangeProfile {
  profile: VolumeProfile;
  /** Taker volume over the range, base units. */
  buy: number;
  sell: number;
  resolution: Resolution;
}

/** Start / end time of the range (points may be placed right to left). */
export function rangeOf(d: Drawing): [number, number] {
  const a = d.points[0].time;
  const b = d.points[1].time;
  return a <= b ? [a, b] : [b, a];
}

/** Profile of the bars `data` holds for the drawing's range. `minMove` = the pair's tick size. */
export function rangeProfile(data: RangeCandles, d: ProfileDrawing, minMove: number): RangeProfile | null {
  if (data.status !== "ready" || data.candles.length === 0) return null;
  const s = profileSettings(d);
  const candles: readonly Candle[] = data.candles;
  const byTicks = s.rowsLayout === "ticks";
  const profile = buildProfile(candles, 0, candles.length - 1, {
    rows: Math.min(ROWS.max, Math.max(ROWS.min, Math.round(s.rowSize))),
    rowSize: byTicks ? Math.min(TICKS.max, Math.max(TICKS.min, Math.round(s.rowSize))) * minMove : undefined,
    split: d.tool === "profile" ? "direction" : "taker",
    valueAreaPct: s.valueArea,
    lvnRatio: 0.35,
  });
  if (!profile) return null;
  let buy = 0;
  let sell = 0;
  for (const c of candles) {
    buy += c.buyVolume;
    sell += c.volume - c.buyVolume;
  }
  return { profile, buy, sell, resolution: data.resolution };
}

/** Figures for the settings panel: key levels and the data resolution used. */
export function profileStatRows(rp: RangeProfile, precision: number): StatRow[] {
  const p = rp.profile;
  const price = (v: number) => formatPrice(v, precision);
  return [
    { label: "POC", value: price(p.rows[p.poc].low + p.rowSize / 2) },
    { label: "VAH / VAL", value: `${price(p.rows[p.vaHigh].low + p.rowSize)} / ${price(p.rows[p.vaLow].low)}` },
    { label: "Data", value: `${rp.resolution.interval} bars` },
  ];
}

/* ───────────────────────────── geometry ───────────────────────────── */

export interface ProfileBox {
  x0: number; // left / right edge of the time range
  x1: number;
  yTop: number; // price extent of the profile
  yBottom: number;
  /** Screen position of each drawing point's handle (index-aligned with d.points). */
  handles: Point[];
}

/** Box around the profile, or (no profile yet) around the drawing's own points. */
export function profileBox(d: Drawing, rp: RangeProfile | null, proj: Projector): ProfileBox | null {
  const [p0, p1] = d.points;
  let top: number;
  let bottom: number;
  if (rp) {
    const { rows, rowSize } = rp.profile;
    top = rows[rows.length - 1].low + rowSize;
    bottom = rows[0].low;
  } else {
    top = Math.max(p0.price, p1.price);
    bottom = Math.min(p0.price, p1.price);
  }
  const a = proj.toPoint({ time: p0.time, price: top });
  const b = proj.toPoint({ time: p1.time, price: bottom });
  if (!a || !b) return null;
  // Without a profile the box may be flat (points at one price): keep it grabbable.
  const pad = rp ? 0 : Math.max(0, 12 - Math.abs(b.y - a.y) / 2);
  const yTop = Math.min(a.y, b.y) - pad;
  const yBottom = Math.max(a.y, b.y) + pad;
  const yMid = (yTop + yBottom) / 2;
  return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), yTop, yBottom, handles: [{ x: a.x, y: yMid }, { x: b.x, y: yMid }] };
}

const HANDLE_HIT = 8;

export function hitProfile(box: ProfileBox, x: number, y: number, withHandles: boolean): Hit["handle"] | "body" | null {
  if (withHandles) {
    const i = box.handles.findIndex((h) => Math.hypot(h.x - x, h.y - y) <= HANDLE_HIT);
    if (i >= 0) return i;
  }
  return x >= box.x0 && x <= box.x1 && y >= box.yTop && y <= box.yBottom ? "body" : null;
}

/* ───────────────────────────── painting ───────────────────────────── */

const FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
const VALUE_FONT = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
// TradingView's default profile colours; value-area rows are drawn more opaque.
const TV_UP = "41, 98, 255";
const TV_DOWN = "251, 192, 45";
const TV_VA_LINE = "rgba(41, 98, 255, 0.9)";
const BUY = "0, 255, 163";
const SELL = "255, 45, 85";
const LVN = "167, 139, 250";
const LEVEL = "rgba(148, 163, 184, 0.8)";

export interface ProfilePaintContext {
  paneWidth: number;
  precision: number;
  base: string; // coin symbol for labels
}

interface Layout {
  box: ProfileBox;
  boxW: number;
  rowY: (i: number) => number;
  rowH: number;
  levelY: (price: number) => number;
  lineEnd: number;
}

function layoutOf(p: VolumeProfile, box: ProfileBox, extend: boolean, paneWidth: number): Layout {
  const height = box.yBottom - box.yTop;
  const pitch = height / p.rows.length;
  return {
    box,
    boxW: Math.max(1, box.x1 - box.x0),
    rowY: (i) => box.yBottom - (i + 1) * pitch,
    rowH: Math.max(1, pitch > 3 ? pitch - 1 : pitch), // 1 px gap between rows while there's room
    levelY: (price) => box.yBottom - ((price - p.rows[0].low) / (p.rowSize * p.rows.length)) * height,
    lineEnd: extend ? paneWidth : box.x1,
  };
}

/** A range whose data is loading or unavailable: its span and a status note. */
export function paintPendingProfile(ctx: CanvasRenderingContext2D, d: Drawing, box: ProfileBox, text: string, selected: boolean): void {
  ctx.strokeStyle = `${d.color}${selected ? "CC" : "66"}`;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(crisp(box.x0, 1), crisp(box.yTop, 1), Math.round(box.x1 - box.x0), Math.round(box.yBottom - box.yTop));
  ctx.setLineDash([]);
  ctx.font = FONT;
  ctx.fillStyle = "rgba(148, 163, 184, 0.9)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, (box.x0 + box.x1) / 2, (box.yTop + box.yBottom) / 2);
  if (selected) paintHandles(ctx, d, box);
}

export function paintProfile(
  ctx: CanvasRenderingContext2D,
  d: ProfileDrawing,
  rp: RangeProfile,
  box: ProfileBox,
  selected: boolean,
  pc: ProfilePaintContext,
): void {
  const s = profileSettings(d);
  const layout = layoutOf(rp.profile, box, s.extend, pc.paneWidth);
  ctx.font = FONT;
  if (d.tool === "profile") paintTradingView(ctx, d, rp.profile, layout, s, selected, pc);
  else paintFlow(ctx, d, rp, layout, s, pc);
  if (selected) paintHandles(ctx, d, box);
}

/** TradingView's look: no frame unless selected, rows from one edge, POC across the range. */
function paintTradingView(
  ctx: CanvasRenderingContext2D,
  d: ProfileDrawing,
  p: VolumeProfile,
  { box, boxW, rowY, rowH, levelY, lineEnd }: Layout,
  s: ProfileSettings,
  selected: boolean,
  pc: ProfilePaintContext,
) {
  if (selected) {
    ctx.fillStyle = `${d.color}0D`;
    ctx.fillRect(box.x0, box.yTop, boxW, box.yBottom - box.yTop);
    ctx.strokeStyle = `${d.color}99`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(crisp(box.x0, 1), crisp(box.yTop, 1), Math.round(boxW), Math.round(box.yBottom - box.yTop));
    ctx.setLineDash([]);
  }

  const maxLen = (boxW * Math.min(100, Math.max(1, s.width))) / 100;
  const dir = s.placement === "left" ? 1 : -1;
  const anchor = s.placement === "left" ? box.x0 : box.x1;
  const span = (from: number, to: number, y: number) => {
    const a = anchor + dir * from;
    const b = anchor + dir * to;
    ctx.fillRect(Math.min(a, b), y, Math.abs(b - a), rowH);
  };
  let maxDelta = 0;
  if (s.volume === "delta") for (const r of p.rows) maxDelta = Math.max(maxDelta, Math.abs(r.buy - r.sell));

  p.rows.forEach((row, i) => {
    const volume = row.buy + row.sell;
    if (volume <= 0) return;
    const y = rowY(i);
    const alpha = i >= p.vaLow && i <= p.vaHigh ? 0.7 : 0.3;
    let len: number;
    let value: number;
    if (s.volume === "delta") {
      value = row.buy - row.sell;
      len = maxDelta > 0 ? (maxLen * Math.abs(value)) / maxDelta : 0;
      ctx.fillStyle = `rgba(${value >= 0 ? TV_UP : TV_DOWN}, ${alpha})`;
      span(0, len, y);
    } else if (s.volume === "total") {
      value = volume;
      len = (maxLen * volume) / p.maxVolume;
      ctx.fillStyle = `rgba(${TV_UP}, ${alpha})`;
      span(0, len, y);
    } else {
      value = volume;
      len = (maxLen * volume) / p.maxVolume;
      const upLen = (len * row.buy) / volume;
      ctx.fillStyle = `rgba(${TV_UP}, ${alpha})`;
      span(0, upLen, y);
      ctx.fillStyle = `rgba(${TV_DOWN}, ${alpha})`;
      span(upLen, len, y);
    }
    if (s.showValues && rowH >= 8) {
      ctx.font = VALUE_FONT;
      ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
      ctx.textBaseline = "middle";
      ctx.textAlign = dir === 1 ? "left" : "right";
      const text = s.volume === "delta" ? formatSigned(value) : formatSigned(value).replace("+", "");
      ctx.fillText(text, anchor + dir * (len + 3), y + rowH / 2);
      ctx.font = FONT;
    }
  });

  const poc = p.rows[p.poc].low + p.rowSize / 2;
  level(ctx, box.x0, lineEnd, levelY(poc), d.color, [], lineWidthOf(d), `POC ${formatPrice(poc, pc.precision)}`);
  if (s.vaLines) {
    const vah = p.rows[p.vaHigh].low + p.rowSize;
    const val = p.rows[p.vaLow].low;
    level(ctx, box.x0, lineEnd, levelY(vah), TV_VA_LINE, [], 1, `VAH ${formatPrice(vah, pc.precision)}`);
    level(ctx, box.x0, lineEnd, levelY(val), TV_VA_LINE, [], 1, `VAL ${formatPrice(val, pc.precision)}`, "below");
  }
}

/** Orderflow profile: delta-coloured rows, LVN zones and levels as trade references. */
function paintFlow(
  ctx: CanvasRenderingContext2D,
  d: ProfileDrawing,
  rp: RangeProfile,
  { box, boxW, rowY, rowH, levelY, lineEnd }: Layout,
  s: ProfileSettings,
  pc: ProfilePaintContext,
) {
  const p = rp.profile;
  ctx.fillStyle = `${d.color}0D`;
  ctx.fillRect(box.x0, box.yTop, boxW, box.yBottom - box.yTop);
  ctx.strokeStyle = `${d.color}40`;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(crisp(box.x0, 1), crisp(box.yTop, 1), Math.round(boxW), Math.round(box.yBottom - box.yTop));
  ctx.setLineDash([]);

  paintLvnZones(ctx, p, box, levelY, lineEnd);

  const maxLen = Math.max(24, (boxW * s.width) / 100);
  p.rows.forEach((row, i) => {
    const volume = row.buy + row.sell;
    if (volume <= 0) return;
    const dominance = (row.buy - row.sell) / volume; // −1 … +1
    const inArea = i >= p.vaLow && i <= p.vaHigh;
    ctx.fillStyle = `rgba(${dominance >= 0 ? BUY : SELL}, ${(0.2 + 0.6 * Math.abs(dominance)) * (inArea ? 1 : 0.6)})`;
    ctx.fillRect(box.x0, rowY(i), (maxLen * volume) / p.maxVolume, rowH);
  });

  const poc = p.rows[p.poc].low + p.rowSize / 2;
  const vah = p.rows[p.vaHigh].low + p.rowSize;
  const val = p.rows[p.vaLow].low;
  level(ctx, box.x0, lineEnd, levelY(poc), d.color, [], lineWidthOf(d), `POC ${formatPrice(poc, pc.precision)}`);
  level(ctx, box.x0, lineEnd, levelY(vah), LEVEL, [5, 3], 1, `VAH ${formatPrice(vah, pc.precision)}`);
  level(ctx, box.x0, lineEnd, levelY(val), LEVEL, [5, 3], 1, `VAL ${formatPrice(val, pc.precision)}`, "below");
  paintSummary(ctx, rp, box, pc);
}

function paintHandles(ctx: CanvasRenderingContext2D, d: Drawing, box: ProfileBox) {
  for (const h of box.handles) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#0B0E11";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = d.color;
    ctx.stroke();
  }
}

function paintLvnZones(ctx: CanvasRenderingContext2D, p: VolumeProfile, box: ProfileBox, levelY: (price: number) => number, lineEnd: number) {
  for (const zone of p.lvns) {
    const top = levelY(p.rows[zone.to].low + p.rowSize);
    const bottom = levelY(p.rows[zone.from].low);
    ctx.fillStyle = `rgba(${LVN}, 0.12)`;
    ctx.fillRect(box.x0, top, lineEnd - box.x0, bottom - top);
    ctx.strokeStyle = `rgba(${LVN}, 0.6)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (const y of [top, bottom]) {
      ctx.beginPath();
      ctx.moveTo(box.x0, crisp(y, 1));
      ctx.lineTo(lineEnd, crisp(y, 1));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = `rgba(${LVN}, 0.95)`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("LVN", lineEnd - 4, (top + bottom) / 2);
  }
}

/** Where the POC sits within the range: the classic profile shapes of auction market theory. */
export function profileShape(p: VolumeProfile): { shape: "P" | "b" | "D"; meaning: string } {
  const at = (p.poc + 0.5) / p.rows.length;
  if (at >= 2 / 3) return { shape: "P", meaning: "buyers in control / short covering" };
  if (at <= 1 / 3) return { shape: "b", meaning: "sellers in control / long liquidation" };
  return { shape: "D", meaning: "balance" };
}

function paintSummary(ctx: CanvasRenderingContext2D, rp: RangeProfile, box: ProfileBox, pc: ProfilePaintContext) {
  const delta = rp.buy - rp.sell;
  const { shape, meaning } = profileShape(rp.profile);
  const text = `Δ ${formatSigned(delta)} ${pc.base} · ${shape}-shape (${meaning})`;
  const w = ctx.measureText(text).width + 10;
  const y = Math.max(2, box.yTop - 18); // stays on screen when the range tops out at the pane edge
  ctx.fillStyle = "rgba(13, 17, 23, 0.85)";
  ctx.fillRect(box.x0, y, w, 15);
  ctx.fillStyle = delta >= 0 ? `rgb(${BUY})` : `rgb(${SELL})`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, box.x0 + 5, y + 7.5);
}

function level(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  color: string,
  dash: number[],
  width: number,
  label: string,
  labelSide: "above" | "below" = "above", // VAL's label goes under its line, clear of a nearby POC
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, crisp(y, width));
  ctx.lineTo(x1, crisp(y, width));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.fillStyle = color;
  ctx.textAlign = "right";
  ctx.textBaseline = labelSide === "above" ? "bottom" : "top";
  ctx.fillText(label, x1 - 4, labelSide === "above" ? y - 2 : y + 2);
}
