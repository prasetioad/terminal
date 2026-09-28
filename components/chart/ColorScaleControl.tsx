"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { formatUsdCompact } from "@/lib/format";
import type { ColorScaleState } from "@/lib/indicators/types";

interface ColorScaleControlProps {
  name: string;
  className?: string;
  state: ColorScaleState;
  /** Called while dragging and on release, with USD values. */
  onChange: (min: number, max: number) => void;
  onAuto: () => void;
}

type Handle = "min" | "max";

/**
 * Slider positions use a square-root scale: liquidity spans orders of magnitude
 * (ordinary levels vs walls), and a linear track would squeeze everything but the
 * largest walls into its first few pixels.
 */
const toPos = (value: number, domain: number) => (domain > 0 ? Math.sqrt(Math.max(0, value) / domain) : 0);
const toValue = (pos: number, domain: number) => Math.pow(Math.min(1, Math.max(0, pos)), 2) * domain;

/** Round to two significant digits so dragged values read cleanly ($1.2M, $85K). */
function tidy(value: number): number {
  if (value <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)) - 1);
  return Math.round(value / magnitude) * magnitude;
}

/** CoinGlass-style colour legend with draggable min / max handles. */
export default function ColorScaleControl({ name, className = "", state, onChange, onAuto }: ColorScaleControlProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  /** While dragging: the values being set and a frozen domain, so handles don't jump with live data. */
  const [drag, setDrag] = useState<{ handle: Handle; min: number; max: number; domain: number } | null>(null);
  const frame = useRef<number | null>(null);

  const domain = drag?.domain ?? (state.domainMax > 0 ? state.domainMax : 1);
  const min = drag?.min ?? state.min;
  const max = drag?.max ?? state.max;
  const minPos = toPos(min, domain);
  const maxPos = toPos(max, domain);

  const valueAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return tidy(toValue((clientX - rect.left) / rect.width, domain));
  };

  /** Keep min below max and push the change out at most once per frame. */
  const apply = (handle: Handle, value: number, current: { min: number; max: number }, frozen: number) => {
    const next =
      handle === "min"
        ? { min: Math.min(value, current.max * 0.98), max: current.max }
        : { min: current.min, max: Math.max(value, current.min * 1.02, 1) };
    setDrag({ handle, ...next, domain: frozen });
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        onChange(next.min, next.max);
      });
    }
    return next;
  };

  const startDrag = (handle: Handle) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ handle, min, max, domain });
  };

  const moveDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    apply(drag.handle, valueAt(e.clientX), drag, drag.domain);
  };

  const endDrag = () => {
    if (!drag) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    onChange(drag.min, drag.max);
    setDrag(null);
  };

  const onKey = (handle: Handle) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const pos = (handle === "min" ? minPos : maxPos) + dir * 0.02;
    const next = apply(handle, tidy(toValue(pos, domain)), { min, max }, domain);
    onChange(next.min, next.max);
    setDrag(null);
  };

  const thumb = (handle: Handle, pos: number, value: number) => (
    <button
      type="button"
      role="slider"
      aria-label={`${name} ${handle === "min" ? "minimum" : "maximum"}`}
      aria-valuemin={0}
      aria-valuemax={Math.round(domain)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={formatUsdCompact(value)}
      onPointerDown={startDrag(handle)}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKey(handle)}
      className="absolute top-1/2 h-4 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-white/80 bg-[#0B0E11] shadow outline-none focus-visible:ring-2 focus-visible:ring-[#00E5FF]"
      style={{ left: `${pos * 100}%` }}
    />
  );

  const manual = state.mode === "manual" || drag !== null;

  return (
    <div className={`font-mono text-[10px] text-slate-400 ${className}`}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="uppercase tracking-wider text-slate-500">{name}</span>
        <button
          type="button"
          onClick={onAuto}
          aria-pressed={!manual}
          title={manual ? "Back to automatic scaling" : "Automatic scaling (drag a handle to set min / max)"}
          className={`rounded px-1.5 py-px uppercase tracking-wider ${
            manual ? "text-slate-400 hover:bg-[#1E2631] hover:text-slate-100" : "bg-[#00E5FF]/15 text-[#00E5FF]"
          }`}
        >
          Auto
        </button>
      </div>

      <div className="mb-1 flex justify-between tabular-nums">
        <span>
          Min <span className="text-slate-100">{formatUsdCompact(min)}</span>
        </span>
        <span>
          Max <span className="text-slate-100">{formatUsdCompact(max)}</span>
        </span>
      </div>

      <div ref={trackRef} className="relative my-2 h-2.5 rounded-sm bg-[#1E2631]">
        {/* Below min: not drawn. Between: the heatmap's own colour ramp. Above max: full colour. */}
        <div
          className="absolute inset-y-0 rounded-sm"
          style={{ left: `${minPos * 100}%`, width: `${Math.max(0, maxPos - minPos) * 100}%`, backgroundImage: state.gradient }}
        />
        <div className="absolute inset-y-0 right-0 rounded-r-sm bg-white/90" style={{ left: `${maxPos * 100}%` }} />
        {thumb("min", minPos, min)}
        {thumb("max", maxPos, max)}
      </div>

      <div className="flex justify-between tabular-nums text-slate-600">
        <span>$0</span>
        <span title="Largest resting liquidity on screen">{formatUsdCompact(domain)}</span>
      </div>
    </div>
  );
}
