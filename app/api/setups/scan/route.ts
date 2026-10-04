import { NextResponse, type NextRequest } from "next/server";
import { scanSetup, type ScanSetup } from "@/lib/server/scanner";
import type { StochPreset } from "@/lib/setups/setupV1";

export const dynamic = "force-dynamic";

const PRESETS: readonly StochPreset[] = ["either", "5,3,3", "14,3,3"];
const SETUPS: readonly ScanSetup[] = ["v1", "a"];

/** A setup across every pair on the last closed 4h bar (cached until the next bar closes). */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const requested = params.get("stoch") as StochPreset | null;
  const stoch = requested && PRESETS.includes(requested) ? requested : "either";
  const setup = SETUPS.find((s) => s === params.get("setup")) ?? "v1";
  try {
    return NextResponse.json(await scanSetup(setup, stoch), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Scan failed" }, { status: 503 });
  }
}
