import { NextResponse, type NextRequest } from "next/server";
import { scanSetupV1 } from "@/lib/server/scanner";
import type { StochPreset } from "@/lib/setups/setupV1";

export const dynamic = "force-dynamic";

const PRESETS: readonly StochPreset[] = ["either", "5,3,3", "14,3,3"];

/** Setup v1 across every pair on the last closed 4h bar (cached until the next bar closes). */
export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get("stoch") as StochPreset | null;
  const stoch = requested && PRESETS.includes(requested) ? requested : "either";
  try {
    return NextResponse.json(await scanSetupV1(stoch), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Scan failed" }, { status: 503 });
  }
}
