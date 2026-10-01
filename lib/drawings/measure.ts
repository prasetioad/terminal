import { barIndexAt, timeToLogical } from "../chart/timeAxis";
import { formatDuration, formatPrice, formatSigned } from "../format";
import type { Candle } from "../types";
import type { Point, Projector } from "./geometry";
import type { Anchor } from "./types";

/**
 * A temporary price/time measurement (TradingView's "Measure"): drag from A to B to
 * read the move, its duration, and the volume and aggressor delta traded in between.
 * Never saved; it disappears on the next click or Escape.
 */
export interface Measurement {
  from: Anchor;
  to: Anchor;
  start: Point; // where the press began, to tell a drag from a click
  phase: "dragging" | "awaiting" | "done";
}

export interface MeasureStats {
  change: number; // to.price − from.price
  percent: number;
  bars: number; // signed: negative when measuring backwards in time
  durationMs: number; // signed
  volume: number; // base units traded in the bars spanned
  delta: number; // taker buy − sell over the same bars
}

export function measureStats(candles: readonly Candle[], intervalMs: number, from: Anchor, to: Anchor): MeasureStats {
  const change = to.price - from.price;
  const la = timeToLogical(candles, intervalMs, from.time) ?? 0;
  const lb = timeToLogical(candles, intervalMs, to.time) ?? 0;

  // Bars whose open lies within the measured span (clamped to the data).
  let volume = 0;
  let delta = 0;
  const first = Math.max(0, barIndexAt(candles, Math.min(from.time, to.time)));
  const last = barIndexAt(candles, Math.max(from.time, to.time));
  for (let i = first; i <= last && i < candles.length; i++) {
    volume += candles[i].volume;
    delta += 2 * candles[i].buyVolume - candles[i].volume;
  }

  return {
    change,
    percent: from.price !== 0 ? (change / from.price) * 100 : 0,
    bars: Math.round(lb - la),
    durationMs: to.time - from.time,
    volume,
    delta,
  };
}

const UP = "0, 255, 163";
const DOWN = "255, 45, 85";
const FONT = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
const LINE_H = 15;
const PAD = 7;

export function measureLines(stats: MeasureStats, precision: number, base: string): string[] {
  const sign = stats.change > 0 ? "+" : stats.change < 0 ? "−" : "";
  const pct = `${stats.percent >= 0 ? "+" : "−"}${Math.abs(stats.percent).toFixed(2)}%`;
  const bars = `${stats.bars} bar${Math.abs(stats.bars) === 1 ? "" : "s"}`;
  return [
    `${sign}${formatPrice(Math.abs(stats.change), precision)} (${pct})`,
    `${bars} · ${formatDuration(stats.durationMs)}`,
    `Vol ${formatSigned(stats.volume).replace("+", "")} ${base} · Δ ${formatSigned(stats.delta)}`,
  ];
}

export function paintMeasure(
  ctx: CanvasRenderingContext2D,
  m: Measurement,
  proj: Projector,
  paneHeight: number,
  lines: readonly string[],
): void {
  const a = proj.toPoint(m.from);
  const b = proj.toPoint(m.to);
  if (!a || !b) return;
  const rgb = m.to.price >= m.from.price ? UP : DOWN;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  const xm = (a.x + b.x) / 2;
  const ym = (a.y + b.y) / 2;

  ctx.fillStyle = `rgba(${rgb}, 0.12)`;
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = `rgba(${rgb}, 0.9)`;
  ctx.fillStyle = `rgba(${rgb}, 0.9)`;
  ctx.lineWidth = 1.5;
  arrow(ctx, { x: xm, y: a.y }, { x: xm, y: b.y });
  arrow(ctx, { x: a.x, y: ym }, { x: b.x, y: ym });

  // Label below the box, or above it when there is no room.
  ctx.font = FONT;
  const labelW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + PAD * 2;
  const labelH = lines.length * LINE_H + PAD;
  const below = y0 + h + 8;
  const top = below + labelH <= paneHeight ? below : Math.max(0, y0 - labelH - 8);
  const left = xm - labelW / 2;
  ctx.fillStyle = `rgba(${rgb}, 0.92)`;
  ctx.beginPath();
  ctx.roundRect(left, top, labelW, labelH, 4);
  ctx.fill();
  ctx.fillStyle = "#0B0E11";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => ctx.fillText(line, xm, top + PAD / 2 + 2 + i * LINE_H));
}

function arrow(ctx: CanvasRenderingContext2D, from: Point, to: Point) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < 2) return;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.min(7, len / 3);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}
