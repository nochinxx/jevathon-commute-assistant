// Real walking time via Google Maps (Browserbase + Stagehand), with a
// haversine-based fallback estimate. This exists because a haversine
// distance / assumed walking speed doesn't know about actual street routing
// -- it can say "4 min away" when the real walk (around a block, across a
// street) is closer to 7, which is exactly the gap that made a ferry look
// makeable when it wasn't. Shared between /api/walk-time (called by the
// iMessage agent) and the dashboard's own /api/route-options, so there's
// one real implementation instead of two that can drift.
import { browserbase, Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v4";

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const WALK_SPEED_KMH = 4.8;

export type WalkTimeResult = { walkMinutes: number; source: "google_maps" | "estimate" };

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimate(fromLat: number, fromLng: number, toLat: number, toLng: number): WalkTimeResult {
  const km = haversineKm(fromLat, fromLng, toLat, toLng);
  return { walkMinutes: Math.round((km / WALK_SPEED_KMH) * 60), source: "estimate" };
}

// Walking pace doesn't fluctuate with live traffic the way transit ETAs do,
// so a long cache is safe and keeps this off the hot path after the first
// real lookup for a given origin/terminal pair.
const cache = new Map<string, { data: WalkTimeResult; expiresAt: number }>();
const CACHE_MS = 30 * 60_000;

const ExtractSchema = z.object({
  walkMinutes: z.number().describe("The total walking duration shown, in minutes"),
});

async function fetchFromMaps(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<number> {
  const browser = await browserbase.launch({ apiKey: BROWSERBASE_API_KEY! });
  const stagehand = await Stagehand.create({ browser });
  try {
    const [page] = await browser.context.pages();
    const url = `https://www.google.com/maps/dir/?api=1&origin=${fromLat}%2C${fromLng}&destination=${toLat}%2C${toLng}&travelmode=walking`;
    await page.goto(url);
    await page.waitForTimeout(5000);
    const { data } = await stagehand.extract(
      "Extract the total walking duration shown in the directions panel for this route.",
      ExtractSchema
    );
    return data.walkMinutes;
  } finally {
    await stagehand.close();
  }
}

export async function getWalkMinutes(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  timeoutMs = 6000
): Promise<WalkTimeResult> {
  const key = `${fromLat.toFixed(4)},${fromLng.toFixed(4)}->${toLat.toFixed(4)},${toLng.toFixed(4)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  if (!BROWSERBASE_API_KEY) return estimate(fromLat, fromLng, toLat, toLng);

  try {
    const walkMinutes = await Promise.race([
      fetchFromMaps(fromLat, fromLng, toLat, toLng),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("walk-time timeout")), timeoutMs)),
    ]);
    const result: WalkTimeResult = { walkMinutes, source: "google_maps" };
    cache.set(key, { data: result, expiresAt: Date.now() + CACHE_MS });
    return result;
  } catch {
    // Real Maps data is preferred but not required -- a live decision
    // shouldn't hang or fail just because a scrape was slow this once.
    return estimate(fromLat, fromLng, toLat, toLng);
  }
}
