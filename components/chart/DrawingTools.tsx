"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { EyeIcon, EyeOffIcon, TrashIcon } from "../icons";
import DrawingSettings from "./DrawingSettings";
import type { DrawingController } from "@/lib/drawings/controller";

import { DRAWING_COLORS, LINE_WIDTHS, MEASURE_TOOL, TOOLS, type ActiveTool, type DrawingTool, type ToolDef } from "@/lib/drawings/types";

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
      {TOOLS.filter((t) => !t.group).map((t) => (
        <ToolButton
          key={t.tool}
          label={`${t.label} (Alt+${t.shortcut})`}
          active={state.tool === t.tool}
          onClick={() => controller.setTool(state.tool === t.tool ? null : t.tool)}
        >
          <ToolIcon tool={t.tool} />
        </ToolButton>
      ))}
      <ToolGroup tools={TOOLS.filter((t) => t.group === "position")} active={state.tool} onSelect={(tool) => controller.setTool(tool)} />

      <span className="my-1 h-px w-6 bg-[#1E2631]" />

      <ToolButton label="Undo (Ctrl/⌘+Z)" active={false} disabled={!state.canUndo} onClick={() => controller.undo()}>
        <UndoIcon />
      </ToolButton>
      <ToolButton label="Redo (Ctrl/⌘+Shift+Z)" active={false} disabled={!state.canRedo} onClick={() => controller.redo()}>
        <UndoIcon redo />
      </ToolButton>

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

/** Floating style bar for the selected drawing, plus its settings panel if it has settings. */
export function DrawingInspector({ controller }: { controller: DrawingController }) {
  const state = useDrawingsState(controller);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  if (!state.selectedId) return null;
  const { selectedOptions: options, selectedFields: fields } = state;
  const hasSettings = fields !== null && options !== null;
  const settingsOpen = hasSettings && settingsFor === state.selectedId;
  return (
    <>
      <div className="absolute left-1/2 top-12 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-[#1E2631] bg-[#0D1117]/95 px-2 py-1.5 shadow-xl backdrop-blur">
        {hasSettings && (
          <>
            <button
              type="button"
              aria-pressed={settingsOpen}
              aria-label="Drawing settings"
              title="Settings"
              onClick={() => setSettingsFor(settingsOpen ? null : state.selectedId)}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                settingsOpen ? "bg-[#00E5FF]/15 text-[#00E5FF]" : "text-slate-400 hover:bg-[#1E2631] hover:text-slate-100"
              }`}
            >
              <GearIcon /> Settings
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
        <div className="flex items-center gap-0.5" role="group" aria-label="Line width">
          {LINE_WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              title={`Line width ${w}px`}
              aria-label={`Line width ${w}px`}
              aria-pressed={state.selectedLineWidth === w}
              onClick={() => controller.setLineWidth(w)}
              className={`flex h-5 w-6 items-center justify-center rounded ${
                state.selectedLineWidth === w ? "bg-[#00E5FF]/15" : "hover:bg-[#1E2631]"
              }`}
            >
              <span
                className={`block w-4 rounded-full ${state.selectedLineWidth === w ? "bg-[#00E5FF]" : "bg-slate-400"}`}
                style={{ height: w }}
              />
            </button>
          ))}
        </div>
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
      {settingsOpen && (
        <DrawingSettings fields={fields} values={options} stats={state.selectedStats} onChange={(key, value) => controller.setOption(key, value)} />
      )}
    </>
  );
}

/**
 * Several tools behind one toolbar button, as in TradingView: the button arms the
 * tool used last; the corner arrow opens the list.
 */
function ToolGroup({ tools, active, onSelect }: { tools: readonly ToolDef[]; active: ActiveTool | null; onSelect: (tool: DrawingTool | null) => void }) {
  const [open, setOpen] = useState(false);
  const [lastUsed, setLastUsed] = useState(tools[0].tool);
  const rootRef = useRef<HTMLDivElement>(null);
  const armed = tools.find((t) => t.tool === active);
  const current = tools.find((t) => t.tool === (armed?.tool ?? lastUsed)) ?? tools[0];

  // Follow keyboard shortcuts too: the button shows whichever of its tools was armed last.
  useEffect(() => {
    if (armed) setLastUsed(armed.tool);
  }, [armed]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (tool: DrawingTool) => {
    setLastUsed(tool);
    setOpen(false);
    onSelect(tool);
  };

  return (
    <div ref={rootRef} className="relative">
      <ToolButton
        label={`${current.label} (Alt+${current.shortcut})`}
        active={armed !== undefined}
        onClick={() => onSelect(armed ? null : current.tool)}
      >
        <ToolIcon tool={current.tool} />
      </ToolButton>
      <button
        type="button"
        aria-label="More tools"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="absolute bottom-0 right-0 flex h-3 w-3 items-end justify-end rounded-sm text-slate-500 hover:text-slate-100"
      >
        <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden>
          <path d="M6 0v6H0z" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Position tools"
          className="absolute left-full top-0 z-30 ml-2 min-w-48 rounded-md border border-[#1E2631] bg-[#0D1117] py-1 shadow-2xl shadow-black/60"
        >
          {tools.map((t) => (
            <button
              key={t.tool}
              type="button"
              role="menuitem"
              onClick={() => pick(t.tool)}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs hover:bg-[#1E2631] ${
                t.tool === active ? "text-[#00E5FF]" : "text-slate-200"
              }`}
            >
              <ToolIcon tool={t.tool} />
              <span className="flex-1">{t.label}</span>
              <span className="font-mono text-[10px] text-slate-500">Alt+{t.shortcut}</span>
            </button>
          ))}
        </div>
      )}
    </div>
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
    case "longPosition":
    case "shortPosition": {
      const long = tool === "longPosition";
      return (
        <svg {...icon}>
          <rect x="4" y="4" width="16" height="8" rx="1" fill={long ? "rgba(8,153,129,0.35)" : "rgba(242,54,69,0.35)"} stroke="none" />
          <rect x="4" y="12" width="16" height="8" rx="1" fill={long ? "rgba(242,54,69,0.35)" : "rgba(8,153,129,0.35)"} stroke="none" />
          <path d="M4 12h16" />
          <path d={long ? "M9 9l3-3 3 3" : "M9 15l3 3 3-3"} />
        </svg>
      );
    }
    case "flowProfile":
      return (
        <svg {...icon}>
          <path d="M4 3v18M4 6h6M4 10h13M4 14h8M4 18h4" />
          <path d="M14 14h6" strokeDasharray="2 2" />
        </svg>
      );
  }
}

const UndoIcon = ({ redo = false }: { redo?: boolean }) => (
  <svg {...icon} style={redo ? { transform: "scaleX(-1)" } : undefined}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </svg>
);
const GearIcon = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
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
