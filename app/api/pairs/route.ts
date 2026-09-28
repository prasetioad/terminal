import { NextResponse } from "next/server";
import { getTopPairs } from "@/lib/server/pairs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getTopPairs();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch {
    return NextResponse.json({ error: "Pair list unavailable" }, { status: 503 });
  }
}
