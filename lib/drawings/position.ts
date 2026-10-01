import { formatPrice } from "../format";
import type { Candle } from "../types";
import { crisp, type Hit, type Point, type Projector } from "./geometry";
import { lineWidthOf, type Anchor, type Drawing, type DrawingOptions, type DrawingTool, type SettingField, type StatRow } from "./types";

/**
 * Long / short position (TradingView's tools): an entry with a profit target and a
 * stop, over a span of time. Points: [entry (start time, entry price),
 * target (end time, target price), stop (end time, stop price)].
 *
 * Size comes either from risk (TradingView's default: risk a share of the account,
 * quantity = risk ÷ loss per unit at the stop) or is entered directly as a quantity
 * or an order value; everything else (value, margin, P&L at target / stop, R:R) is
 * derived, net of fees. The candles after the entry tell whether target or stop was
 * hit, or what the trade stands at now.
 */
export type PositionTool = Extract<DrawingTool, "longPosition" | "shortPosition">;
export type PositionDrawing = Drawing & { tool: PositionTool };

export const isPositionTool = (tool: DrawingTool): tool is PositionTool => tool === "longPosition" || tool === "shortPosition";
export const isPositionDrawing = (d: Drawing): d is PositionDrawing => isPositionTool(d.tool);

/* ───────────────────────────── settings ───────────────────────────── */

export type Sizing = "risk" | "qty" | "value";

export interface PositionSettings {
  account: number; // USDT
  sizing: Sizing;
  risk: number;
  riskUnit: "percent" | "usd";
  qty: number; // base units
  value: number; // order value, USDT
  leverage: number;
  feePct: number; // per side, % of notional
  alwaysStats: boolean;
}

// TradingView's defaults (account 1000, risk 25 %), no fees, no leverage.
const DEFAULTS: PositionSettings = {
  account: 1000,
  sizing: "risk",
  risk: 25,
  riskUnit: "percent",
  qty: 1,
  value: 1000,
  leverage: 1,
  feePct: 0,
  alwaysStats: false,
};

/** Levels are edited in the settings too; they live in the drawing's points. */
export const LEVEL_KEYS = ["entry", "target", "stop"] as const;
export type LevelKey = (typeof LEVEL_KEYS)[number];
export const isLevelKey = (key: string): key is LevelKey => (LEVEL_KEYS as readonly string[]).includes(key);

export function positionFields(minMove: number): SettingField[] {
  const price = { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, step: minMove } as const;
  const sizing = (s: Sizing) => (v: DrawingOptions) => v.sizing === s;
  return [
    { key: "entry", label: "Entry price", ...price },
    { key: "target", label: "Profit level", ...price },
    { key: "stop", label: "Stop level", ...price },
    { key: "account", label: "Account size (USDT)", type: "number", min: 0, max: 1e12, step: 0.01 },
    {
      key: "sizing",
      label: "Position size by",
      type: "select",
      options: [
        { value: "risk", label: "Risk" },
        { value: "qty", label: "Quantity" },
        { value: "value", label: "Order value (USDT)" },
      ],
    },
    { key: "risk", label: "Risk", type: "number", min: 0, max: 1e12, step: 0.01, when: sizing("risk") },
    {
      key: "riskUnit",
      label: "Risk in",
      type: "select",
      options: [
        { value: "percent", label: "% of account" },
        { value: "usd", label: "USDT" },
      ],
      when: sizing("risk"),
    },
    { key: "qty", label: "Quantity", type: "number", min: 0, max: 1e15, step: 0.00000001, when: sizing("qty") },
    { key: "value", label: "Order value (USDT)", type: "number", min: 0, max: 1e12, step: 0.01, when: sizing("value") },
    { key: "leverage", label: "Leverage", type: "number", min: 1, max: 200, step: 1, suffix: "×" },
    { key: "feePct", label: "Fee per side", type: "number", min: 0, max: 5, step: 0.001, suffix: "%" },
    { key: "alwaysStats", label: "Always show stats", type: "boolean" },
  ];
}

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export function positionSettings(d: PositionDrawing): PositionSettings {
  const o = d.options ?? {};
  return {
    account: num(o.account, DEFAULTS.account),
    sizing: o.sizing === "qty" || o.sizing === "value" ? o.sizing : "risk",
    risk: num(o.risk, DEFAULTS.risk),
    riskUnit: o.riskUnit === "usd" ? "usd" : "percent",
    qty: num(o.qty, DEFAULTS.qty),
    value: num(o.value, DEFAULTS.value),
    leverage: Math.max(1, num(o.leverage, DEFAULTS.leverage)),
    feePct: Math.max(0, num(o.feePct, DEFAULTS.feePct)),
    alwaysStats: typeof o.alwaysStats === "boolean" ? o.alwaysStats : DEFAULTS.alwaysStats,
  };
}

/* ───────────────────────────── levels ───────────────────────────── */

export interface Levels {
  start: number; // ms
  end: number;
  entry: number;
  target: number;
  stop: number;
}

export const levelsOf = (d: Drawing): Levels => ({
  start: d.points[0].time,
  end: d.points[1].time,
  entry: d.points[0].price,
  target: d.points[1].price,
  stop: d.points[2].price,
});

const pointsOf = (l: Levels): Anchor[] => [
  { time: l.start, price: l.entry },
  { time: l.end, price: l.target },
  { time: l.end, price: l.stop },
];

/** +1 long, −1 short: the direction profit is in. */
const dirOf = (tool: DrawingTool) => (tool === "longPosition" ? 1 : -1);

/** A new position at `entry`, `risk` price units to the stop, target at 2R, lasting `spanMs`. */
export function newPosition(tool: PositionTool, entry: Anchor, risk: number, spanMs: number): Anchor[] {
  const dir = dirOf(tool);
  return pointsOf({ start: entry.time, end: entry.time + spanMs, entry: entry.price, target: entry.price + dir * 2 * risk, stop: entry.price - dir * risk });
}

/**
 * Keep the levels valid: target on the profit side of the entry, stop on the loss
 * side (at least one tick apart), and the span at least `minSpanMs` long.
 */
function constrain(tool: DrawingTool, l: Levels, fixed: "entry" | "target" | "stop", tick: number, minSpanMs: number): Levels {
  const dir = dirOf(tool);
  const out = { ...l };
  if (fixed === "entry") {
    // Moving the entry: it may not cross the other two.
    const lo = Math.min(out.target, out.stop) + tick;
    const hi = Math.max(out.target, out.stop) - tick;
    out.entry = Math.min(hi, Math.max(lo, out.entry));
  } else if (fixed === "target") {
    out.target = dir > 0 ? Math.max(out.entry + tick, out.target) : Math.min(out.entry - tick, out.target);
  } else {
    out.stop = dir > 0 ? Math.min(out.entry - tick, out.stop) : Math.max(out.entry + tick, out.stop);
  }
  if (out.end - out.start < minSpanMs) out.end = out.start + minSpanMs;
  return out;
}

/** Handles: 0 entry (time + price), 1 target (price), 2 stop (price), 3 right edge (end time). */
export const POSITION_HANDLES = 4;

export function movePositionHandle(d: PositionDrawing, handle: number, to: Anchor, tick: number, minSpanMs: number): Anchor[] {
  const l = levelsOf(d);
  switch (handle) {
    case 0:
      return pointsOf(constrain(d.tool, { ...l, start: Math.min(to.time, l.end - minSpanMs), entry: to.price }, "entry", tick, minSpanMs));
    case 1:
      return pointsOf(constrain(d.tool, { ...l, target: to.price }, "target", tick, minSpanMs));
    case 2:
      return pointsOf(constrain(d.tool, { ...l, stop: to.price }, "stop", tick, minSpanMs));
    default:
      return pointsOf(constrain(d.tool, { ...l, end: to.time }, "entry", tick, minSpanMs));
  }
}

/** Set one level from the settings panel. */
export function setPositionLevel(d: PositionDrawing, key: LevelKey, price: number, tick: number, minSpanMs: number): Anchor[] {
  return pointsOf(constrain(d.tool, { ...levelsOf(d), [key]: price }, key, tick, minSpanMs));
}

/* ───────────────────────────── the numbers ───────────────────────────── */

export type Outcome =
  | { kind: "pending" } // entry time not reached
  | { kind: "open"; time: number; price: number; pnl: number } // time: the latest bar
  | { kind: "target" | "stop"; time: number; price: number; pnl: number }
  | { kind: "expired"; time: number; price: number; pnl: number }; // span ended without either

export interface PositionStats {
  dir: 1 | -1;
  qty: number;
  value: number; // notional at entry, USDT
  margin: number;
  targetPnl: number; // net of fees
  stopPnl: number; // negative
  rr: number; // price reward ÷ price risk, like TradingView
  targetPct: number;
  stopPct: number;
  riskOfAccount: number; // % of the account lost at the stop
  outcome: Outcome;
}

export function positionStats(d: PositionDrawing, candles: readonly Candle[]): PositionStats {
  const s = positionSettings(d);
  const l = levelsOf(d);
  const dir = dirOf(d.tool) as 1 | -1;
  const fee = s.feePct / 100;
  const riskPerUnit = Math.abs(l.entry - l.stop);
  const rewardPerUnit = Math.abs(l.target - l.entry);
  // Loss per unit at the stop includes the fees on both fills.
  const lossPerUnit = riskPerUnit + fee * (l.entry + l.stop);

  let qty: number;
  if (s.sizing === "qty") qty = s.qty;
  else if (s.sizing === "value") qty = l.entry > 0 ? s.value / l.entry : 0;
  else {
    const riskUsd = s.riskUnit === "percent" ? (s.account * s.risk) / 100 : s.risk;
    qty = lossPerUnit > 0 ? riskUsd / lossPerUnit : 0;
  }
  const pnlAt = (exit: number) => qty * (dir * (exit - l.entry) - fee * (l.entry + exit));
  const value = qty * l.entry;
  const stopPnl = pnlAt(l.stop);
  return {
    dir,
    qty,
    value,
    margin: value / s.leverage,
    targetPnl: pnlAt(l.target),
    stopPnl,
    rr: riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0,
    targetPct: (rewardPerUnit / l.entry) * 100,
    stopPct: (riskPerUnit / l.entry) * 100,
    riskOfAccount: s.account > 0 ? (-stopPnl / s.account) * 100 : 0,
    outcome: outcomeOf(l, dir, candles, pnlAt),
  };
}

/**
 * Walk the bars from the entry: the first to reach the stop or the target decides.
 * A bar reaching both counts as the stop (without ticks, the conservative reading).
 */
const t0 = (c: Candle) => c.time * 1000;

function outcomeOf(l: Levels, dir: 1 | -1, candles: readonly Candle[], pnlAt: (exit: number) => number): Outcome {
  let last: Candle | null = null;
  for (const c of candles) {
    const t = c.time * 1000;
    if (t < l.start) continue;
    if (t >= l.end) break;
    last = c;
    const hitStop = dir > 0 ? c.low <= l.stop : c.high >= l.stop;
    const hitTarget = dir > 0 ? c.high >= l.target : c.low <= l.target;
    if (hitStop) return { kind: "stop", time: t, price: l.stop, pnl: pnlAt(l.stop) };
    if (hitTarget) return { kind: "target", time: t, price: l.target, pnl: pnlAt(l.target) };
  }
  if (!last) return { kind: "pending" };
  const lastBar = candles[candles.length - 1];
  if (last === lastBar && lastBar.time * 1000 < l.end) return { kind: "open", time: t0(last), price: last.close, pnl: pnlAt(last.close) };
  return { kind: "expired", time: t0(last), price: last.close, pnl: pnlAt(last.close) };
}

/* ───────────────────────────── formatting ───────────────────────────── */

const amount = (v: number) =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Base-unit quantity: 4 significant digits below 1 (0.001234), up to 4 decimals above. */
export const formatUnits = (v: number) =>
  v === 0 ? "0" : Math.abs(v) < 1 ? String(Number(v.toPrecision(4))) : v.toLocaleString("en-US", { maximumFractionDigits: 4 });

const OUTCOME_LABEL: Record<Outcome["kind"], string> = {
  pending: "Not started",
  open: "Open P&L",
  target: "Target hit",
  stop: "Stop hit",
  expired: "Closed at end",
};

export function positionStatRows(st: PositionStats, base: string, s: PositionSettings): StatRow[] {
  const o = st.outcome;
  const rows: StatRow[] = [
    o.kind === "pending"
      ? { label: "Status", value: OUTCOME_LABEL.pending }
      : { label: OUTCOME_LABEL[o.kind], value: `${amount(o.pnl)} USDT`, tone: o.pnl >= 0 ? "up" : "down" },
    { label: "Quantity", value: `${formatUnits(st.qty)} ${base}` },
    { label: "Order value", value: `${usd(st.value)} USDT` },
  ];
  if (s.leverage > 1) rows.push({ label: `Margin (${s.leverage}×)`, value: `${usd(st.margin)} USDT` });
  rows.push(
    { label: "Target", value: `${amount(st.targetPnl)} (+${st.targetPct.toFixed(2)}%)`, tone: "up" },
    { label: "Stop", value: `${amount(st.stopPnl)} (−${st.stopPct.toFixed(2)}%)`, tone: "down" },
    { label: "Risk of account", value: `${st.riskOfAccount.toFixed(2)}%` },
    { label: "Risk / reward", value: st.rr.toFixed(2) },
  );
  return rows;
}

/* ───────────────────────────── geometry ───────────────────────────── */

export interface PositionBox {
  x0: number;
  x1: number;
  yEntry: number;
  yTarget: number;
  yStop: number;
  handles: Point[]; // POSITION_HANDLES of them
}

export function positionBox(d: Drawing, proj: Projector): PositionBox | null {
  const l = levelsOf(d);
  const a = proj.toPoint({ time: l.start, price: l.entry });
  const b = proj.toPoint({ time: l.end, price: l.target });
  const c = proj.toPoint({ time: l.end, price: l.stop });
  if (!a || !b || !c) return null;
  return {
    x0: a.x,
    x1: b.x,
    yEntry: a.y,
    yTarget: b.y,
    yStop: c.y,
    handles: [
      { x: a.x, y: a.y },
      { x: a.x, y: b.y },
      { x: a.x, y: c.y },
      { x: b.x, y: a.y },
    ],
  };
}

const HANDLE_HIT = 8;

export function hitPosition(box: PositionBox, x: number, y: number, withHandles: boolean): Hit["handle"] | "body" | null {
  if (withHandles) {
    const i = box.handles.findIndex((h) => Math.hypot(h.x - x, h.y - y) <= HANDLE_HIT);
    if (i >= 0) return i;
  }
  const inX = x >= Math.min(box.x0, box.x1) && x <= Math.max(box.x0, box.x1);
  const inY = y >= Math.min(box.yTarget, box.yStop) && y <= Math.max(box.yTarget, box.yStop);
  return inX && inY ? "body" : null;
}

/* ───────────────────────────── painting ───────────────────────────── */

// TradingView's position colours.
const PROFIT = "8, 153, 129";
const LOSS = "242, 54, 69";
const FONT = "11px ui-monospace, SFMono-Regular, Menlo, monospace";

export interface PositionPaintContext {
  precision: number;
  base: string;
  /** x of a bar time on the chart, for the trade's path to its exit. */
  xAt: (ms: number) => number | null;
  yAt: (price: number) => number | null;
}

export function paintPosition(
  ctx: CanvasRenderingContext2D,
  d: PositionDrawing,
  box: PositionBox,
  st: PositionStats,
  showStats: boolean,
  selected: boolean,
  pc: PositionPaintContext,
): void {
  const { x0, x1, yEntry, yTarget, yStop } = box;
  const left = Math.min(x0, x1);
  const width = Math.max(1, Math.abs(x1 - x0));
  ctx.fillStyle = `rgba(${PROFIT}, 0.2)`;
  ctx.fillRect(left, Math.min(yEntry, yTarget), width, Math.abs(yTarget - yEntry));
  ctx.fillStyle = `rgba(${LOSS}, 0.2)`;
  ctx.fillRect(left, Math.min(yEntry, yStop), width, Math.abs(yStop - yEntry));

  // The trade so far: shaded from the entry to the exit (or the latest price), with its path.
  const o = st.outcome;
  if (o.kind !== "pending") {
    const exitX = pc.xAt(o.time);
    const exitY = pc.yAt(o.price);
    if (exitX !== null && exitY !== null) {
      const x = Math.min(Math.max(exitX, left), left + width);
      ctx.fillStyle = `rgba(${o.pnl >= 0 ? PROFIT : LOSS}, 0.28)`;
      ctx.fillRect(left, Math.min(yEntry, exitY), x - left, Math.abs(exitY - yEntry));
      ctx.strokeStyle = "rgba(226, 232, 240, 0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, yEntry);
      ctx.lineTo(x, exitY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  const lw = lineWidthOf(d);
  ctx.lineWidth = lw;
  ctx.strokeStyle = d.color;
  ctx.beginPath();
  ctx.moveTo(left, crisp(yEntry, lw));
  ctx.lineTo(left + width, crisp(yEntry, lw));
  ctx.stroke();

  if (showStats) {
    const s = positionSettings(d);
    const l = levelsOf(d);
    const price = (p: number) => formatPrice(p, pc.precision);
    const cx = left + width / 2;
    const targetText = `Target: ${price(l.target)} (${st.targetPct.toFixed(2)}%) · ${amount(st.targetPnl)}`;
    const stopText = `Stop: ${price(l.stop)} (${st.stopPct.toFixed(2)}%) · ${amount(st.stopPnl)}`;
    const status =
      o.kind === "pending" ? "Not started" : `${OUTCOME_LABEL[o.kind]}: ${amount(o.pnl)}`;
    const up = yTarget < yStop; // long: target above
    label(ctx, targetText, cx, up ? yTarget - 4 : yTarget + 4, up ? "above" : "below", `rgb(${PROFIT})`);
    label(ctx, stopText, cx, up ? yStop + 4 : yStop - 4, up ? "below" : "above", `rgb(${LOSS})`);
    label(
      ctx,
      `${status} · Qty: ${formatUnits(st.qty)}${s.leverage > 1 ? ` · ${s.leverage}×` : ""}\nRisk/Reward Ratio: ${st.rr.toFixed(2)}`,
      cx,
      yEntry,
      "center",
      o.kind === "pending" ? "rgba(71, 85, 105, 0.95)" : o.pnl >= 0 ? `rgb(${PROFIT})` : `rgb(${LOSS})`,
    );
  }

  if (selected) {
    for (const h of box.handles) {
      ctx.fillStyle = "#0B0E11";
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 1.5;
      ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
      ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
    }
  }
}

/** A filled label box of one or more lines, placed above, below or centred on y. */
function label(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, side: "above" | "below" | "center", bg: string) {
  ctx.font = FONT;
  const lines = text.split("\n");
  const lineH = 15;
  const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 12;
  const h = lines.length * lineH + 6;
  const top = side === "above" ? y - h : side === "below" ? y : y - h / 2;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, top, w, h, 3);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((t, i) => ctx.fillText(t, cx, top + 3 + lineH * (i + 0.5)));
}
