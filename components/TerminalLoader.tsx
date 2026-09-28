"use client";

import dynamic from "next/dynamic";

// The terminal is canvas + WebSocket + Web Audio: browser-only, so skip SSR entirely.
const OrderflowTerminal = dynamic(() => import("./OrderflowTerminal"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-[#0B0E11] font-mono text-xs uppercase tracking-[0.3em] text-slate-500">
      Booting terminal…
    </div>
  ),
});

export default function TerminalLoader() {
  return <OrderflowTerminal />;
}
