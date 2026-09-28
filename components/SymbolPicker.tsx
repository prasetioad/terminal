"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PairsStatus } from "@/hooks/usePairs";
import type { Pair } from "@/lib/types";

interface SymbolPickerProps {
  pairs: Pair[];
  value: string;
  onChange: (symbol: string) => void;
  status: PairsStatus;
}

const STATUS_NOTE: Record<PairsStatus, string> = {
  loading: "Loading CMC ranking…",
  "cmc-live": "Live CMC ranking",
  "cmc-snapshot": "CMC offline · snapshot ranking",
  error: "Pair list unavailable",
};

/** Searchable combobox over the CMC-ranked pairs. Keyboard: ↑ ↓ Enter Esc. */
export default function SymbolPicker({ pairs, value, onChange, status }: SymbolPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const current = pairs.find((p) => p.symbol === value);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return pairs;
    return pairs.filter((p) => p.base.includes(q) || p.name.toUpperCase().includes(q));
  }, [pairs, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(Math.max(0, pairs.findIndex((p) => p.symbol === value)));
    inputRef.current?.focus();
  }, [open, pairs, value]);

  // Keep the highlighted row in view.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const select = (pair: Pair) => {
    onChange(pair.symbol);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pair = filtered[active];
      if (pair) select(pair);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded border border-[#1E2631] bg-[#0B0E11] px-2 py-1.5 text-left font-mono text-xs text-slate-100 outline-none hover:border-slate-500 focus:border-[#00E5FF]/60"
      >
        {current && <span className="w-7 shrink-0 text-[10px] text-slate-500">#{current.rank}</span>}
        <span className="font-semibold">{current?.base ?? value.replace(/USDT$/, "")}</span>
        <span className="text-slate-500">/USDT</span>
        <span className="ml-auto truncate text-[10px] text-slate-500">{current?.name}</span>
        <span className="text-slate-500">▾</span>
      </button>
      <div className={`mt-1 text-[10px] ${status === "error" || status === "cmc-snapshot" ? "text-amber-400" : "text-slate-600"}`}>
        {STATUS_NOTE[status]}
        {status !== "loading" && status !== "error" && ` · ${pairs.length} pairs`}
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-9 z-30 overflow-hidden rounded border border-[#1E2631] bg-[#0D1117] shadow-2xl shadow-black/60">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search coin…"
            role="combobox"
            aria-controls={listId}
            aria-expanded
            aria-activedescendant={filtered[active] ? `${listId}-${filtered[active].symbol}` : undefined}
            className="w-full border-b border-[#1E2631] bg-[#0B0E11] px-2.5 py-2 font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600"
          />
          <ul ref={listRef} id={listId} role="listbox" className="max-h-72 overflow-y-auto py-1">
            {filtered.map((p, i) => (
              <li
                key={p.symbol}
                id={`${listId}-${p.symbol}`}
                role="option"
                aria-selected={p.symbol === value}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => select(p)}
                onMouseMove={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 font-mono text-xs ${
                  i === active ? "bg-[#00E5FF]/10" : ""
                } ${p.symbol === value ? "text-[#00E5FF]" : "text-slate-200"}`}
              >
                <span className="w-8 shrink-0 text-[10px] text-slate-500">#{p.rank}</span>
                <span className="font-semibold">{p.base}</span>
                <span className="ml-auto truncate text-[10px] text-slate-500">{p.name}</span>
              </li>
            ))}
            {filtered.length === 0 && <li className="px-2.5 py-3 text-center text-xs text-slate-600">No match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
