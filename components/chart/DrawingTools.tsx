"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { EyeIcon, EyeOffIcon, TrashIcon } from "../icons";
import type { DrawingController } from "@/lib/drawings/controller";
import { PROFILE_LIMITS, isProfileTool } from "@/lib/drawings/profiles";
import { DRAWING_COLORS, MEASURE_TOOL, TOOLS, type DrawingTool } from "@/lib/drawings/types";

const useDrawingsState = (controller: DrawingController) =>
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

/** Vertical tool strip on the left edge of the chart. */
export function DrawingToolbar({ controller }: { controller: DrawingController }) {
  const state = useDrawingsState(controller);
  const [confirmClear, setConfirmClear] = useState(false);

  // The clear button needs a second click within a few seconds.
  useEffect(() => {
    if (!confirmClear) return;
    const id = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(id);
  }, [confirmClear]);

  return (
    <nav
      aria-label="Drawing tools"
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-[#1E2631] bg-[#0D1117] py-2"
    >
      <ToolButton label="Cursor (Esc)" active={state.tool === null} onClick={() => controller.setTool(null)}>
        <CursorIcon />
      </ToolButton>
      {TOOLS.map((t) => (
        <ToolButton
          key={t.tool}
          label={`${t.label} (Alt+${t.shortcut})`}
          active={state.tool === t.tool}
          onClick={() => controller.setTool(state.tool === t.tool ? null : t.tool)}
        >
          <ToolIcon tool={t.tool} />
        </ToolButton>
      ))}

      <span className="my-1 h-px w-6 bg-[#1E2631]" />

      <ToolButton
        label={`${MEASURE_TOOL.label} (Alt+${MEASURE_TOOL.shortcut}, or Shift+drag)`}
        active={state.tool === "measure"}
        onClick={() => controller.setTool(state.tool === "measure" ? null : "measure")}
      >
        <RulerIcon />
      </ToolButton>

      <ToolButton label={state.magnet ? "Magnet on: snaps to OHLC" : "Magnet off"} active={state.magnet} onClick={() => controller.toggleMagnet()}>
        <MagnetIcon />
      </ToolButton>
      <ToolButton label={state.hidden ? "Show drawings" : "Hide drawings"} active={state.hidden} onClick={() => controller.toggleHidden()}>
        {state.hidden ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
      </ToolButton>
      <ToolButton
        label={confirmClear ? "Click again to delete all drawings" : "Delete all drawings"}
        active={confirmClear}
        danger
        disabled={state.count === 0}
        onClick={() => {
          if (confirmClear) {
            controller.clearAll();
            setConfirmClear(false);
          } else {
            setConfirmClear(true);
          }
        }}
      >
        <TrashIcon />
      </ToolButton>
    </nav>
  );
}

/** Floating style bar for the selected drawing. */
export function DrawingInspector({ controller }: { controller: DrawingController }) {
  const state = useDrawingsState(controller);
  if (!state.selectedId) return null;
  const options = state.selectedOptions;
  const isProfile = state.selectedTool !== null && isProfileTool(state.selectedTool) && options !== null;
  return (
    <div className="absolute left-1/2 top-12 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-[#1E2631] bg-[#0D1117]/95 px-2 py-1.5 shadow-xl backdrop-blur">
      {isProfile && (
        <>
          <Stepper
            label="Rows"
            value={Number(options.rows)}
            {...PROFILE_LIMITS.rows}
            onChange={(v) => controller.setOption("rows", v)}
          />
          <Stepper
            label="VA"
            suffix="%"
            value={Number(options.valueArea)}
            {...PROFILE_LIMITS.valueArea}
            onChange={(v) => controller.setOption("valueArea", v)}
          />
          <button
            type="button"
            aria-pressed={Boolean(options.extend)}
            title="Extend POC / value area / LVN levels to the right"
            onClick={() => controller.setOption("extend", !options.extend)}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
              options.extend ? "bg-[#00E5FF]/15 text-[#00E5FF]" : "text-slate-400 hover:bg-[#1E2631] hover:text-slate-100"
            }`}
          >
            Extend
          </button>
          <span className="mx-1 h-4 w-px bg-[#1E2631]" />
        </>
      )}
      {DRAWING_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Colour ${c}`}
          aria-pressed={state.selectedColor === c}
          onClick={() => controller.setColor(c)}
          className={`h-4 w-4 rounded-full border-2 ${state.selectedColor === c ? "border-white" : "border-transparent"}`}
          style={{ background: c }}
        />
      ))}
      <span className="mx-1 h-4 w-px bg-[#1E2631]" />
      <button
        type="button"
        onClick={() => controller.deleteSelected()}
        title="Delete (Del)"
        aria-label="Delete drawing"
        className="rounded p-0.5 text-slate-400 hover:bg-[#FF2D55]/15 hover:text-[#FF2D55]"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function Stepper({
  label,
  suffix = "",
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  suffix?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const button = "flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-[#1E2631] hover:text-slate-100 disabled:opacity-30";
  return (
    <span className="flex items-center gap-0.5 font-mono text-[10px] text-slate-400" role="group" aria-label={label}>
      <span className="mr-0.5 uppercase text-slate-500">{label}</span>
      <button type="button" className={button} aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>
        −
      </button>
      <span className="w-8 text-center tabular-nums text-slate-100">
        {value}
        {suffix}
      </span>
      <button type="button" className={button} aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>
        +
      </button>
    </span>
  );
}

function ToolButton({
  label,
  active,
  danger = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const tone = danger
    ? active
      ? "bg-[#FF2D55]/20 text-[#FF2D55]"
      : "text-slate-400 hover:bg-[#FF2D55]/10 hover:text-[#FF2D55]"
    : active
      ? "bg-[#00E5FF]/15 text-[#00E5FF]"
      : "text-slate-400 hover:bg-[#1E2631] hover:text-slate-100";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded transition-colors disabled:opacity-30 ${tone}`}
    >
      {children}
    </button>
  );
}

const icon = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function ToolIcon({ tool }: { tool: DrawingTool }) {
  switch (tool) {
    case "trendline":
      return (
        <svg {...icon}>
          <path d="M5 19 19 5" />
          <circle cx="5" cy="19" r="1.8" fill="currentColor" />
          <circle cx="19" cy="5" r="1.8" fill="currentColor" />
        </svg>
      );
    case "hline":
      return (
        <svg {...icon}>
          <path d="M3 12h18" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
        </svg>
      );
    case "rectangle":
      return (
        <svg {...icon}>
          <rect x="4" y="6" width="16" height="12" rx="1" />
        </svg>
      );
    case "fib":
      return (
        <svg {...icon}>
          <path d="M4 5h16M4 9.5h16M4 13h16M4 19h16" />
        </svg>
      );
    case "profile":
      return (
        <svg {...icon}>
          <path d="M4 3v18M4 6h7M4 10h12M4 14h9M4 18h5" />
        </svg>
      );
    case "flowProfile":
      return (
        <svg {...icon}>
          <path d="M4 3v18M4 6h6M4 10h13M4 14h8M4 18h4" />
          <path d="M14 14h6" strokeDasharray="2 2" />
        </svg>
      );
  }
}

const RulerIcon = () => (
  <svg {...icon}>
    <path d="M3 17 17 3l4 4L7 21z" />
    <path d="M7 13l2 2M10 10l2 2M13 7l2 2" />
  </svg>
);
const CursorIcon = () => (
  <svg {...icon}>
    <path d="M5 3l6.5 17 2.3-7.2L21 10.5z" />
  </svg>
);
const MagnetIcon = () => (
  <svg {...icon}>
    <path d="M6 3v8a6 6 0 0 0 12 0V3M6 7h4M14 7h4" />
  </svg>
);
