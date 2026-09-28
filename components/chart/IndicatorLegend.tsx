"use client";

import { CloseIcon, EyeIcon, EyeOffIcon, GearIcon } from "../icons";
import type { LegendValue } from "@/lib/indicators/types";

export interface LegendRow {
  uid: string;
  name: string;
  summary: string;
  values: LegendValue[];
  visible: boolean;
}

interface LegendActions {
  onEdit: (uid: string) => void;
  onToggle: (uid: string) => void;
  onRemove: (uid: string) => void;
}

/** One indicator line: name, params, live values and hover actions, TradingView-style. */
export function IndicatorLegendRow({ row, onEdit, onToggle, onRemove }: { row: LegendRow } & LegendActions) {
  return (
    <div className="group pointer-events-auto flex max-w-full items-center gap-2 rounded bg-[#0B0E11]/75 px-1.5 py-0.5 font-mono text-[11px] backdrop-blur-[2px] hover:bg-[#11161D]/95">
      <span className={`whitespace-nowrap ${row.visible ? "text-slate-200" : "text-slate-600 line-through"}`}>{row.name}</span>
      {row.summary && <span className="min-w-[4.5rem] truncate text-slate-500">{row.summary}</span>}
      {row.visible &&
        row.values.map((v, i) => (
          <span key={i} className="whitespace-nowrap tabular-nums" style={{ color: v.color }}>
            {v.label && <span className="mr-1 text-slate-500">{v.label}</span>}
            {v.text}
          </span>
        ))}
      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <LegendButton label={row.visible ? "Hide" : "Show"} onClick={() => onToggle(row.uid)}>
          {row.visible ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
        </LegendButton>
        <LegendButton label="Settings" onClick={() => onEdit(row.uid)}>
          <GearIcon size={13} />
        </LegendButton>
        <LegendButton label="Remove" onClick={() => onRemove(row.uid)}>
          <CloseIcon size={13} />
        </LegendButton>
      </span>
    </div>
  );
}

function LegendButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-[#1E2631] hover:text-slate-100"
    >
      {children}
    </button>
  );
}
