import { formatPrice } from "../format";
import { FIB_LEVELS, type Anchor, type Drawing, type DrawingTool } from "./types";

/** Shapes drawn purely from their points (range profiles live in profiles.ts). */
export type SimpleDrawing = Drawing & { tool: Exclude<DrawingTool, "profile" | "flowProfile"> };

export const isSimpleDrawing = (d: Drawing): d is SimpleDrawing => d.tool !== "profile" && d.tool !== "flowProfile";

export interface Point {
  x: number;
  y: number;
}

/** Maps anchors to pixels on the price pane. */
export interface Projector {
  toPoint(anchor: Anchor): Point | null;
  width: number;
}

export interface Hit {
  id: string;
  /** Index of the grabbed point, or null when the body was grabbed. */
  handle: number | null;
}

const HANDLE_RADIUS = 4.5;
const HANDLE_HIT = 8;
const LINE_HIT = 6;
const FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

/** Price of a fib level: 0 at the second point (where the swing ended), 1 at the first. */
export const fibPrice = (d: Drawing, level: number) => d.points[1].price + (d.points[0].price - d.points[1].price) * level;

function project(d: Drawing, proj: Projector): Point[] | null {
  const pts: Point[] = [];
  for (const a of d.points) {
    const p = proj.toPoint(a);
    if (!p) return null;
    pts.push(p);
  }
  return pts;
}

export function paintDrawing(ctx: CanvasRenderingContext2D, d: SimpleDrawing, proj: Projector, selected: boolean, precision: number): void {
  const pts = project(d, proj);
  if (!pts) return;
  ctx.strokeStyle = d.color;
  ctx.fillStyle = d.color;
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.font = FONT;

  switch (d.tool) {
    case "hline": {
      const y = Math.round(pts[0].y) + 0.5;
      line(ctx, 0, y, proj.width, y);
      priceTag(ctx, formatPrice(d.points[0].price, precision), proj.width, y, d.color);
      break;
    }
    case "trendline":
      line(ctx, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      break;
    case "rectangle": {
      const x = Math.min(pts[0].x, pts[1].x);
      const y = Math.min(pts[0].y, pts[1].y);
      const w = Math.abs(pts[1].x - pts[0].x);
      const h = Math.abs(pts[1].y - pts[0].y);
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
      break;
    }
    case "fib": {
      const x0 = Math.min(pts[0].x, pts[1].x);
      const x1 = Math.max(pts[0].x, pts[1].x);
      const ys = FIB_LEVELS.map((level) => proj.toPoint({ time: d.points[0].time, price: fibPrice(d, level) })?.y ?? null);
      // Faint bands between consecutive levels, then the level lines with labels.
      for (let i = 0; i < ys.length - 1; i++) {
        const a = ys[i];
        const b = ys[i + 1];
        if (a === null || b === null) continue;
        ctx.globalAlpha = i % 2 === 0 ? 0.07 : 0.03;
        ctx.fillRect(x0, Math.min(a, b), x1 - x0, Math.abs(b - a));
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      FIB_LEVELS.forEach((level, i) => {
        const y = ys[i];
        if (y === null) return;
        ctx.lineWidth = level === 0.5 || level === 0.618 ? 1.5 : 1;
        line(ctx, x0, Math.round(y) + 0.5, x1, Math.round(y) + 0.5);
        ctx.fillText(`${level} (${formatPrice(fibPrice(d, level), precision)})`, x0 - 6, y);
      });
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.6;
      line(ctx, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      break;
    }
  }

  if (selected) {
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "#0B0E11";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = d.color;
      ctx.stroke();
    }
  }
}

/** Handle index (only when `withHandles`), "body", or null if (x, y) misses the drawing. */
export function hitDrawing(d: SimpleDrawing, proj: Projector, x: number, y: number, withHandles: boolean): number | "body" | null {
  if (withHandles) {
    const handle = project(d, proj)?.findIndex((p) => Math.hypot(p.x - x, p.y - y) <= HANDLE_HIT) ?? -1;
    if (handle >= 0) return handle;
  }
  return hitsBody(d, proj, x, y) ? "body" : null;
}

function hitsBody(d: SimpleDrawing, proj: Projector, x: number, y: number): boolean {
  const pts = project(d, proj);
  if (!pts) return false;
  switch (d.tool) {
    case "hline":
      return Math.abs(y - pts[0].y) <= LINE_HIT;
    case "trendline":
      return distanceToSegment(x, y, pts[0], pts[1]) <= LINE_HIT;
    case "rectangle": {
      const inX = x >= Math.min(pts[0].x, pts[1].x) - LINE_HIT && x <= Math.max(pts[0].x, pts[1].x) + LINE_HIT;
      const inY = y >= Math.min(pts[0].y, pts[1].y) - LINE_HIT && y <= Math.max(pts[0].y, pts[1].y) + LINE_HIT;
      return inX && inY;
    }
    case "fib": {
      if (x < Math.min(pts[0].x, pts[1].x) - LINE_HIT || x > Math.max(pts[0].x, pts[1].x) + LINE_HIT) return false;
      return FIB_LEVELS.some((level) => {
        const p = proj.toPoint({ time: d.points[0].time, price: fibPrice(d, level) });
        return p !== null && Math.abs(y - p.y) <= LINE_HIT;
      });
    }
  }
}

function distanceToSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function priceTag(ctx: CanvasRenderingContext2D, text: string, right: number, y: number, color: string) {
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = color;
  ctx.fillRect(right - w, y - 8, w, 16);
  ctx.fillStyle = "#0B0E11";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(text, right - 4, y);
}
