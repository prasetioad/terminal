"use client";

import type { ScanResult } from "@/lib/server/scanner";
import { SETUP_V1 } from "@/lib/setups/setupV1";

interface MarketRegimeProps {
  /** Latest Setup v1 scan (breadth). */
  v1: ScanResult | null;
  /** Latest Setup A scan (confirmed breakouts); both scans carry Fear & Greed and BTC vs 200D. */
  a: ScanResult | null;
  onOpen: () => void;
}

const fgTone = (v: number) => (v < 25 ? "text-[#FF2D55]" : v < 50 ? "text-amber-300" : "text-[#00FFA3]");
const fgWord = (v: number) => (v < 25 ? "Extreme fear" : v < 50 ? "Fear" : v < 75 ? "Greed" : "Extreme greed");

/**
 * Market conditions on the last closed 4h bar, at a glance: what each setup is seeing.
 * Breadth ≥ 10 is when Setup v1.1 trades; extreme fear is where breakouts did worst.
 */
export default function MarketRegime({ v1, a, onOpen }: MarketRegimeProps) {
  const ref = a ?? v1;
  if (!ref) return null;
  const fg = ref.fearGreed;
  const btc = ref.btcVs200d;
  const breadth = v1?.breadth ?? null;
  const capitulation = breadth !== null && breadth >= SETUP_V1.minBreadth;
  const sep = <span className="text-slate-600">·</span>;
  const title = [
    "Market on the last closed 4h bar",
    "Fear & Greed (alternative.me): breakouts (Setup A) did worst in extreme fear (< 25).",
    "BTC vs its 200-day average: above = bull regime.",
    `Breadth: pairs with a new Setup v1 entry on this bar; v1.1 trades only at ≥ ${SETUP_V1.minBreadth} (market-wide capitulation).`,
    "Breakouts: confirmed Setup A entries on this bar.",
    "Click to open the scanner.",
  ].join("\n");

  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      aria-label="Market conditions"
      className={`flex items-center gap-2 rounded border bg-[#0B0E11]/80 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-400 backdrop-blur hover:border-[#00E5FF]/50 ${capitulation ? "border-[#00FFA3]/60" : "border-[#1E2631]"}`}
    >
      {fg !== null && (
        <span>
          F&amp;G <span className={fgTone(fg)}>{fg}</span> <span className="normal-case text-slate-500">{fgWord(fg)}</span>
        </span>
      )}
      {btc !== null && (
        <>
          {fg !== null && sep}
          <span>
            BTC <span className={btc >= 0 ? "text-[#00FFA3]" : "text-[#FF2D55]"}>{btc >= 0 ? "▲" : "▼"} 200D</span>{" "}
            <span className="text-slate-500">
              {btc >= 0 ? "+" : ""}
              {(btc * 100).toFixed(0)}%
            </span>
          </span>
        </>
      )}
      {breadth !== null && (
        <>
          {sep}
          <span>
            Breadth <span className={capitulation ? "font-bold text-[#00FFA3]" : "text-slate-200"}>{breadth}</span>
            <span className="text-slate-500">/{SETUP_V1.minBreadth}</span>
          </span>
        </>
      )}
      {a && (
        <>
          {sep}
          <span>
            Breakouts <span className={a.breadth > 0 ? "text-[#00FFA3]" : "text-slate-200"}>{a.breadth}</span>
          </span>
        </>
      )}
    </button>
  );
}
