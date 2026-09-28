import { barIndexAt } from "../chart/timeAxis";
import { formatPrice, formatSigned } from "../format";
import { buildProfile, type VolumeProfile } from "../profile";
import type { Candle } from "../types";
import type { Hit, Point, Projector } from "./geometry";
import type { Drawing, DrawingTool } from "./types";

/**
 * Range profiles: drawings whose two points pick a time range; the volume profile of
 * the bars in that range is drawn inside it.
 *  - "profile":     TradingView's Fixed Range Volume Profile (up/down volume, POC, value area).
 *  - "flowProfile": orderflow profile for Fabio Valentini's approach — rows coloured by
 *                   aggressor delta, LVN zones / POC / VAH / VAL extended right as trade
 *                   levels, and the profile's shape (P / b / D) to read balance vs imbalance.
 */
export type ProfileTool = Extract<DrawingTool, "profile" | "flowProfile">;

export type ProfileDrawing = Drawing & { tool: ProfileTool };

export const isProfileTool = (tool: DrawingTool): tool is ProfileTool => tool === "profile" || tool === "flowProfile";
export const isProfileDrawing = (d: Drawing): d is ProfileDrawing => isProfileTool(d.tool);

export interface ProfileOptions {
  rows: number;
  valueArea: number; // %
  extend: boolean; // extend key levels to the right edge
}

const DEFAULTS: Record<ProfileTool, ProfileOptions> = {
  profile: { rows: 24, valueArea: 70, extend: false }, // TradingView's defaults
  flowProfile: { rows: 48, valueArea: 70, extend: true },
};

export const PROFILE_LIMITS = {
  rows: { min: 8, max: 200, step: 4 },
  valueArea: { min: 50, max: 95, step: 5 },
} as const;

export function profileOptions(d: ProfileDrawing): ProfileOptions {
  const o = d.options ?? {};
  const base = DEFAULTS[d.tool];
  return {
    rows: typeof o.rows === "number" ? o.rows : base.rows,
    valueArea: typeof o.valueArea === "number" ? o.valueArea : base.valueArea,
    extend: typeof o.extend === "boolean" ? o.extend : base.extend,
  };
}

export interface RangeProfile {
  profile: VolumeProfile;
  buy: number; // taker volume over the range, base units
  sell: number;
}

/** Profile of every bar the range touches (the bars containing its start and end included). */
export function rangeProfile(candles: readonly Candle[], d: ProfileDrawing): RangeProfile | null {
  if (candles.length === 0) return null;
  const [t0, t1] = [d.points[0].time, d.points[1].time].sort((a, b) => a - b);
  const first = Math.max(0, barIndexAt(candles, t0));
  const last = barIndexAt(candles, t1);
  if (last < first) return null;
  const opts = profileOptions(d);
  const profile = buildProfile(candles, first, last, { rows: opts.rows, valueAreaPct: opts.valueArea, lvnRatio: 0.35 });
  if (!profile) return null;
  let buy = 0;
  let sell = 0;
  for (let i = first; i <= last; i++) {
    buy += candles[i].buyVolume;
    sell += candles[i].volume - candles[i].buyVolume;
  }
  return { profile, buy, sell };
}

export interface ProfileBox {
  x0: number; // left / right edge of the time range
  x1: number;
  yTop: number; // price extent of the profile
  yBottom: number;
  /** Screen position of each drawing point's handle (index-aligned with d.points). */
  handles: Point[];
}

export function profileBox(d: Drawing, rp: RangeProfile, proj: Projector): ProfileBox | null {
  const { rows, rowSize } = rp.profile;
  const top = rows[rows.length - 1].low + rowSize;
  const bottom = rows[0].low;
  const a = proj.toPoint({ time: d.points[0].time, price: top });
  const b = proj.toPoint({ time: d.points[1].time, price: bottom });
  if (!a || !b) return null;
  const yMid = (a.y + b.y) / 2;
  return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), yTop: a.y, yBottom: b.y, handles: [{ x: a.x, y: yMid }, { x: b.x, y: yMid }] };
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
const TV_UP = "41, 98, 255";
const TV_DOWN = "251, 192, 45";
const BUY = "0, 255, 163";
const SELL = "255, 45, 85";
const LVN = "167, 139, 250";

export interface ProfilePaintContext {
  paneWidth: number;
  precision: number;
  base: string; // coin symbol for labels
}

export function paintProfile(
  ctx: CanvasRenderingContext2D,
  d: ProfileDrawing,
  rp: RangeProfile,
  box: ProfileBox,
  selected: boolean,
  pc: ProfilePaintContext,
): void {
  const opts = profileOptions(d);
  const { profile: p } = rp;
  const boxW = Math.max(1, box.x1 - box.x0);
  const rowY = (i: number) => box.yBottom - ((i + 1) * (box.yBottom - box.yTop)) / p.rows.length;
  const rowH = Math.max(1, (box.yBottom - box.yTop) / p.rows.length - 1);
  const levelY = (price: number) => box.yBottom - ((price - p.rows[0].low) / (p.rowSize * p.rows.length)) * (box.yBottom - box.yTop);
  const lineEnd = opts.extend ? pc.paneWidth : box.x1;
  ctx.font = FONT;

  // Range box
  ctx.fillStyle = `${d.color}0D`;
  ctx.fillRect(box.x0, box.yTop, boxW, box.yBottom - box.yTop);
  ctx.strokeStyle = `${d.color}${selected ? "CC" : "40"}`;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(Math.round(box.x0) + 0.5, Math.round(box.yTop) + 0.5, Math.round(boxW), Math.round(box.yBottom - box.yTop));
  ctx.setLineDash([]);

  if (d.tool === "flowProfile") paintLvnZones(ctx, p, box, levelY, lineEnd);

  // Rows, anchored at the range's left edge
  const maxLen = Math.max(24, boxW * (d.tool === "profile" ? 0.35 : 0.45));
  p.rows.forEach((row, i) => {
    const volume = row.buy + row.sell;
    if (volume <= 0) return;
    const len = (maxLen * volume) / p.maxVolume;
    const y = rowY(i);
    const inArea = i >= p.vaLow && i <= p.vaHigh;
    if (d.tool === "profile") {
      const upLen = (len * row.buy) / volume;
      ctx.fillStyle = `rgba(${TV_UP}, ${inArea ? 0.7 : 0.3})`;
      ctx.fillRect(box.x0, y, upLen, rowH);
      ctx.fillStyle = `rgba(${TV_DOWN}, ${inArea ? 0.7 : 0.3})`;
      ctx.fillRect(box.x0 + upLen, y, len - upLen, rowH);
    } else {
      const dominance = (row.buy - row.sell) / volume; // −1 … +1
      const rgb = dominance >= 0 ? BUY : SELL;
      ctx.fillStyle = `rgba(${rgb}, ${(0.2 + 0.6 * Math.abs(dominance)) * (inArea ? 1 : 0.6)})`;
      ctx.fillRect(box.x0, y, len, rowH);
    }
  });

  // Key levels
  const poc = p.rows[p.poc].low + p.rowSize / 2;
  const vah = p.rows[p.vaHigh].low + p.rowSize;
  const val = p.rows[p.vaLow].low;
  level(ctx, box.x0, lineEnd, levelY(poc), d.color, [], 1.5, `POC ${formatPrice(poc, pc.precision)}`);
  if (d.tool === "flowProfile" || selected) {
    level(ctx, box.x0, lineEnd, levelY(vah), "rgba(148, 163, 184, 0.8)", [5, 3], 1, `VAH ${formatPrice(vah, pc.precision)}`);
    level(ctx, box.x0, lineEnd, levelY(val), "rgba(148, 163, 184, 0.8)", [5, 3], 1, `VAL ${formatPrice(val, pc.precision)}`, "below");
  }

  if (d.tool === "flowProfile") paintSummary(ctx, rp, box, pc);

  if (selected) {
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
}

function paintLvnZones(ctx: CanvasRenderingContext2D, p: VolumeProfile, box: ProfileBox, levelY: (price: number) => number, lineEnd: number) {
  for (const zone of p.lvns) {
    const top = levelY(p.rows[zone.to].low + p.rowSize);
    const bottom = levelY(p.rows[zone.from].low);
    ctx.fillStyle = `rgba(${LVN}, 0.12)`;
    ctx.fillRect(box.x0, top, lineEnd - box.x0, bottom - top);
    ctx.strokeStyle = `rgba(${LVN}, 0.6)`;
    ctx.setLineDash([2, 3]);
    for (const y of [top, bottom]) {
      ctx.beginPath();
      ctx.moveTo(box.x0, Math.round(y) + 0.5);
      ctx.lineTo(lineEnd, Math.round(y) + 0.5);
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
  ctx.moveTo(x0, Math.round(y) + 0.5);
  ctx.lineTo(x1, Math.round(y) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.fillStyle = color;
  ctx.textAlign = "right";
  ctx.textBaseline = labelSide === "above" ? "bottom" : "top";
  ctx.fillText(label, x1 - 4, labelSide === "above" ? y - 2 : y + 2);
}
