"use client";

import { useEffect, useRef, useState } from "react";
import ColorScaleControl from "./ColorScaleControl";
import Modal, { ModalButton } from "../Modal";
import { DRAWING_COLORS } from "@/lib/drawings/types";
import { indicatorDefinition } from "@/lib/indicators/registry";
import {
  defaultParams,
  resolveParams,
  type ColorScaleParams,
  type ColorScaleState,
  type IndicatorConfig,
  type IndicatorParams,
  type ParamSpec,
} from "@/lib/indicators/types";

interface IndicatorSettingsProps {
  config: IndicatorConfig;
  /** Applied live while editing (TradingView-style); Cancel re-applies the original. */
  onChange: (params: IndicatorParams) => void;
  onClose: () => void;
  /** Live colour-scale state from the chart, for indicators with a colour scale. */
  getColorScale?: () => ColorScaleState | null;
}

const COLOR_SCALE_REFRESH_MS = 500;
const NEUTRAL_GRADIENT = "linear-gradient(to right, #1E2631, #E2E8F0)";

/** Settings form generated from the indicator's parameter schema, previewed live on the chart. */
export default function IndicatorSettings({ config, onChange, onClose, getColorScale }: IndicatorSettingsProps) {
  const def = indicatorDefinition(config.type);
  const [original] = useState<IndicatorParams>(() => (def ? resolveParams(def, config.params) : {}));
  const [draft, setDraft] = useState<IndicatorParams>(original);
  const [liveScale, setLiveScale] = useState<ColorScaleState | null>(() => getColorScale?.() ?? null);
  const scaleKeys = def?.colorScaleParams;
  // Callers may pass a new function every render (the terminal re-renders several times a
  // second); read it through a ref so the polling interval isn't restarted each time.
  const getColorScaleRef = useRef(getColorScale);
  useEffect(() => {
    getColorScaleRef.current = getColorScale;
  });

  // The slider's range follows the data on screen while the dialog is open.
  useEffect(() => {
    if (!scaleKeys) return;
    const id = setInterval(() => setLiveScale(getColorScaleRef.current?.() ?? null), COLOR_SCALE_REFRESH_MS);
    return () => clearInterval(id);
  }, [scaleKeys]);

  if (!def) return null;

  const update = (next: IndicatorParams) => {
    setDraft(next);
    onChange(next);
  };
  const set = (key: string, value: IndicatorParams[string]) => update({ ...draft, [key]: value });
  const cancel = () => {
    onChange(original);
    onClose();
  };

  const scaleParamKeys = scaleKeys ? new Set([scaleKeys.mode, scaleKeys.min, scaleKeys.max]) : new Set<string>();
  const scale = scaleKeys ? scaleState(draft, scaleKeys, liveScale) : null;
  const specOf = (key: string) => def.params.find((p) => p.key === key);

  return (
    <Modal
      title={`${def.name} settings`}
      onClose={cancel}
      footer={
        <>
          <ModalButton onClick={() => update(defaultParams(def))}>Reset to defaults</ModalButton>
          <ModalButton onClick={cancel}>Cancel</ModalButton>
          <ModalButton primary onClick={onClose}>
            Apply
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        {def.params
          .filter((spec) => !scaleParamKeys.has(spec.key))
          .map((spec) => (
            <Field key={spec.key} spec={spec} value={draft[spec.key]} onChange={(v) => set(spec.key, v)} />
          ))}

        {scaleKeys && scale && (
          <section className="mt-1 flex flex-col gap-3 border-t border-[#1E2631] pt-3">
            <ColorScaleControl
              name="Colour scale"
              className="w-full"
              state={scale}
              onChange={(min, max) =>
                update({ ...draft, [scaleKeys.mode]: "manual", [scaleKeys.min]: Math.round(min), [scaleKeys.max]: Math.round(max) })
              }
              onAuto={() => update({ ...draft, [scaleKeys.mode]: "auto" })}
            />
            <p className="text-[11px] leading-relaxed text-slate-500">
              Below <span className="text-slate-300">Min</span> nothing is drawn; at or above{" "}
              <span className="text-slate-300">Max</span> the colour is brightest. Drag a handle or type exact USD values.
            </p>
            {[scaleKeys.min, scaleKeys.max].map((key) => {
              const spec = specOf(key);
              // In auto mode show the effective range; typing a value switches to manual.
              const shown = scale.mode === "manual" ? draft[key] : Math.round(key === scaleKeys.min ? scale.min : scale.max);
              return spec ? (
                <Field
                  key={key}
                  spec={spec}
                  value={shown}
                  onChange={(v) => update({ ...draft, [scaleKeys.mode]: "manual", [key]: v })}
                />
              ) : null;
            })}
          </section>
        )}
      </div>
    </Modal>
  );
}

/** What the slider shows: the draft's manual values, or the live auto range. */
function scaleState(
  draft: IndicatorParams,
  keys: ColorScaleParams,
  live: ColorScaleState | null,
): ColorScaleState {
  const manual = draft[keys.mode] === "manual";
  const min = manual ? Number(draft[keys.min]) : (live?.min ?? 0);
  const max = manual ? Number(draft[keys.max]) : (live?.max ?? 0);
  return {
    mode: manual ? "manual" : "auto",
    min,
    max,
    domainMax: Math.max(live?.domainMax ?? 0, min, max),
    gradient: live?.gradient ?? NEUTRAL_GRADIENT,
  };
}

const inputClass =
  "rounded border border-[#1E2631] bg-[#0B0E11] px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-[#00E5FF]/60";

function Field({ spec, value, onChange }: { spec: ParamSpec; value: IndicatorParams[string]; onChange: (v: IndicatorParams[string]) => void }) {
  switch (spec.type) {
    case "number":
      return (
        <Row label={spec.label}>
          <input
            type="number"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={Number(value)}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(Math.min(spec.max, Math.max(spec.min, n)));
            }}
            className={`${inputClass} w-28 text-right`}
          />
        </Row>
      );
    case "select":
      return (
        <Row label={spec.label}>
          <select value={String(value)} onChange={(e) => onChange(e.target.value)} className={`${inputClass} min-w-44`}>
            {spec.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
      );
    case "boolean":
      return (
        <Row label={spec.label}>
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#00E5FF]" />
        </Row>
      );
    case "color":
      return (
        <Row label={spec.label}>
          <span className="flex gap-1.5" role="radiogroup" aria-label={spec.label}>
            {DRAWING_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={value === c}
                aria-label={c}
                onClick={() => onChange(c)}
                className={`h-5 w-5 rounded-full border-2 ${value === c ? "border-white" : "border-transparent"}`}
                style={{ background: c }}
              />
            ))}
          </span>
        </Row>
      );
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-4 text-xs text-slate-300">
      <span>{label}</span>
      {children}
    </label>
  );
}
