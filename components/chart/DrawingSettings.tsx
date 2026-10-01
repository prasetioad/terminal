"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { DrawingOptionValue, DrawingOptions, SettingField, StatRow } from "@/lib/drawings/types";

interface DrawingSettingsProps {
  fields: readonly SettingField[];
  values: DrawingOptions;
  /** Computed figures above the inputs (null while loading); omitted when the drawing has none. */
  stats: readonly StatRow[] | null;
  onChange: (key: string, value: DrawingOptionValue) => void;
}

const TONE = { up: "text-[#00FFA3]", down: "text-[#FF2D55]" } as const;

/** Settings of the selected drawing, rendered from its field list (TradingView-style inputs). */
export default function DrawingSettings({ fields, values, stats, onChange }: DrawingSettingsProps) {
  return (
    <div
      className="absolute left-1/2 top-[5.25rem] z-20 max-h-[calc(100%-6rem)] w-72 -translate-x-1/2 overflow-y-auto rounded-md border border-[#1E2631] bg-[#0D1117]/95 p-3 shadow-xl backdrop-blur"
      role="group"
      aria-label="Drawing settings"
    >
      <dl
        className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-b border-[#1E2631] pb-2 font-mono text-[10px] tabular-nums"
        aria-label="Drawing figures"
      >
        {stats ? (
          stats.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-slate-500">{row.label}</dt>
              <dd className={`text-right ${row.tone ? TONE[row.tone] : "text-slate-100"}`} data-stat={row.label}>
                {row.value}
              </dd>
            </div>
          ))
        ) : (
          <dd className="col-span-2 text-slate-500">Loading…</dd>
        )}
      </dl>
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 text-xs">
        {fields
          .filter((field) => !field.when || field.when(values))
          .map((field) => (
            <Field key={field.key} field={field} value={values[field.key]} onChange={(v) => onChange(field.key, v)} />
          ))}
      </div>
    </div>
  );
}

const control = "rounded border border-[#1E2631] bg-[#0B0E11] px-1.5 py-1 font-mono text-[11px] text-slate-100 outline-none focus:border-[#00E5FF]/60";

function Field({ field, value, onChange }: { field: SettingField; value: DrawingOptionValue | undefined; onChange: (v: DrawingOptionValue) => void }) {
  const id = `setting-${field.key}`;
  const label = (
    <label htmlFor={id} className="text-slate-400">
      {field.label}
    </label>
  );
  switch (field.type) {
    case "boolean":
      return (
        <>
          {label}
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="h-3.5 w-3.5 justify-self-end accent-[#00E5FF]"
          />
        </>
      );
    case "select":
      return (
        <>
          {label}
          <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} className={`${control} justify-self-end`}>
            {field.options.map((o: { value: string; label: string }) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      );
    case "number":
      return (
        <>
          {label}
          <NumberInput id={id} field={field} value={Number(value)} onChange={onChange} />
        </>
      );
  }
}

/** Decimals a step has (0.01 → 2, 0.25 → 2, 1e-8 → 8), so snapped values don't carry float noise. */
const decimalsOf = (step: number) => (step.toFixed(12).replace(/0+$/, "").split(".")[1] ?? "").length;

/** Commits on Enter or blur (not per keystroke, so typing "48" is one undo step), clamped to the field's range. */
function NumberInput({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: Extract<SettingField, { type: "number" }>;
  value: number;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  /** Escape blurs the field; the blur must then discard the edit, not commit it. */
  const cancelled = useRef(false);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() === "" || !Number.isFinite(n)) return;
    const snapped = Number((Math.round(n / field.step) * field.step).toFixed(decimalsOf(field.step)));
    const clamped = Math.min(field.max, Math.max(field.min, snapped));
    if (clamped !== value) onChange(clamped);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      cancelled.current = true;
      e.currentTarget.blur();
    }
  };
  return (
    <span className="flex items-center gap-1 justify-self-end">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={field.min}
        max={field.max}
        step={field.step}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className={`${control} w-24 text-right tabular-nums`}
      />
      {field.suffix && <span className="w-3 text-slate-500">{field.suffix}</span>}
    </span>
  );
}
