"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

/** Centered dialog: Escape or a backdrop click closes it, focus moves inside on open. */
export default function Modal({ title, onClose, children, footer, width = "max-w-md" }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const first = panelRef.current?.querySelector<HTMLElement>("input, select, button");
    first?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`flex max-h-[76vh] w-full ${width} flex-col overflow-hidden rounded-lg border border-[#1E2631] bg-[#0D1117] shadow-2xl shadow-black/70`}
      >
        <div className="flex items-center justify-between border-b border-[#1E2631] px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-slate-100">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-[#1E2631] hover:text-slate-100">
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-[#1E2631] px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ModalButton({ onClick, children, primary = false }: { onClick: () => void; children: ReactNode; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
        primary ? "bg-[#00E5FF]/20 text-[#00E5FF] hover:bg-[#00E5FF]/30" : "text-slate-300 hover:bg-[#1E2631]"
      }`}
    >
      {children}
    </button>
  );
}
