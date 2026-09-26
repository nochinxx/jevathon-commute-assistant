import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TRIP_LOG_SECRET = process.env.TRIP_LOG_SECRET;
const MAX_ENTRIES = 20;

type TripLogEntry = {
  receivedAt: string;
  source: "imessage" | "dashboard";
  origin: { lat: number; lng: number; label: string };
  destination: { lat: number; lng: number; label: string };
  goal?: string;
  deadlineISO?: string | null;
  options: { mode: string; etaMinutes: number | null; reliability: string }[];
  decision: { choice: string; confidence: number; probabilities: Record<string, number> } | null;
  relevanceNotes?: string[];
};

// In-memory only -- fine for a live demo (the function stays warm across the
// 5s polling interval), not a durable store. A real deployment would use
// Vercel KV or similar; this is the "connect iMessage and the dashboard"
// wiring, not a persistence layer.
declare global {
  // eslint-disable-next-line no-var
  var __tripLog: TripLogEntry[] | undefined;
}
const store: TripLogEntry[] = (globalThis.__tripLog ??= []);

export async function POST(req: Request) {
  if (!TRIP_LOG_SECRET) {
    return NextResponse.json({ error: "TRIP_LOG_SECRET not configured" }, { status: 500 });
  }
  const body = await req.json().catch(() => null);
  if (!body || body.secret !== TRIP_LOG_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { secret: _secret, ...entry } = body;
  store.unshift({ ...entry, receivedAt: new Date().toISOString() });
  store.length = Math.min(store.length, MAX_ENTRIES);
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ trips: store });
}
