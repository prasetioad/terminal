"use client";

import { useMemo, useState } from "react";
import Modal from "../Modal";
import { INDICATORS } from "@/lib/indicators/registry";
import type { IndicatorConfig } from "@/lib/indicators/types";

interface IndicatorPickerProps {
  active: readonly IndicatorConfig[];
  onAdd: (type: string) => void;
  onClose: () => void;
}

/** Searchable indicator list. Stays open so several can be added in a row. */
export default function IndicatorPicker({ active, onAdd, onClose }: IndicatorPickerProps) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? INDICATORS.filter((d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q))
      : INDICATORS;
  }, [query]);

  const categories = [...new Set(results.map((d) => d.category))];

  return (
    <Modal title="Indicators" onClose={onClose} width="max-w-lg">
      <div className="border-b border-[#1E2631] p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search indicators…"
          className="w-full rounded border border-[#1E2631] bg-[#0B0E11] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-[#00E5FF]/60"
        />
      </div>
      {categories.map((category) => (
        <section key={category}>
          <h3 className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">{category}</h3>
          <ul>
            {results
              .filter((d) => d.category === category)
              .map((def) => {
                const count = active.filter((c) => c.type === def.type).length;
                return (
                  <li key={def.type}>
                    <button
                      type="button"
                      onClick={() => onAdd(def.type)}
                      className="group flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-[#11161D]"
                    >
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[#00E5FF]/10 text-xs text-[#00E5FF]">
                        +
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm text-slate-100">
                          {def.name}
                          <span className="rounded bg-[#1E2631] px-1.5 text-[9px] uppercase tracking-wider text-slate-400">
                            {def.placement === "pane" ? "Pane" : "Overlay"}
                          </span>
                          {count > 0 && <span className="text-[10px] text-[#00FFA3]">{count} on chart</span>}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{def.description}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
      {results.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-600">No indicator matches “{query}”.</p>}
    </Modal>
  );
}
