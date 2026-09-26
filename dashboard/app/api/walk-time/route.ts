import { NextResponse } from "next/server";
import { getWalkMinutes } from "../../../lib/walk-time";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const fromLat = Number(searchParams.get("fromLat"));
  const fromLng = Number(searchParams.get("fromLng"));
  const toLat = Number(searchParams.get("toLat"));
  const toLng = Number(searchParams.get("toLng"));
  if ([fromLat, fromLng, toLat, toLng].some((n) => Number.isNaN(n))) {
    return NextResponse.json({ error: "missing/invalid fromLat/fromLng/toLat/toLng" }, { status: 400 });
  }
  const result = await getWalkMinutes(fromLat, fromLng, toLat, toLng);
  return NextResponse.json(result);
}
