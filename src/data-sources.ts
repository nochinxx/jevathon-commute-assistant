// Normalized multi-modal transport data layer.
// Each function returns { mode, etaMinutes, reliability, raw } or null on failure.

type TransportOption = {
  mode: string;
  etaMinutes: number | null;
  reliability: string; // short human description
  raw: unknown;
};

const FIVE_ELEVEN_TOKEN = process.env.FIVE_ELEVEN_TOKEN;

/** Fixed ferry terminal locations (verified coordinates). */
export const FERRY_TERMINALS: Record<string, { lat: number; lng: number }> = {
  sausalito: { lat: 37.8419, lng: -122.4785 },
  larkspur: { lat: 37.945, lng: -122.5089 },
  tiburon: { lat: 37.8735, lng: -122.4566 },
};

/**
 * Real geocoding via OpenStreetMap Nominatim (free, no API key). A
 * descriptive User-Agent is required by Nominatim's usage policy or
 * requests get blocked.
 */
export async function geocode(
  query: string
): Promise<{ lat: number; lng: number; displayName: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      query
    )}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Jevathon-CommuteAssistant/1.0 (hackathon project)" },
    });
    if (!res.ok) return null;
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return null;
    const r = results[0];
    return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), displayName: r.display_name };
  } catch {
    return null;
  }
}

const FILLER_WORDS = new Set([
  "i",
  "im",
  "i'm",
  "need",
  "to",
  "get",
  "from",
  "form", // common typo for "from"
  "the",
  "a",
  "an",
  "at",
  "by",
  "heading",
  "head",
  "going",
  "go",
  "office",
  "offices",
  "what's",
  "whats",
  "what",
  "is",
  "way",
  "do",
  "it",
  "how",
  "should",
  "that",
  "work",
  "where",
  "and",
  "for",
  "my",
  "please",
  "can",
  "you",
  "help",
  "me",
  "best",
  "there",
]);

/**
 * Turn a free-text message into an ordered list of candidate place queries
 * to try geocoding, since Nominatim needs a real place name, not a full
 * sentence (verified: geocoding the raw sentence returns nothing). Jev
 * can't do this extraction itself -- it's a discriminative model (Choice/
 * Score/Noul), not a text generator -- so this is a plain heuristic:
 * split on common origin/destination separator words, strip filler words
 * from each segment, and return non-empty segments as candidates, longest
 * (most specific) first.
 */
export function extractPlaceQueries(text: string): string[] {
  // Strip deadline expressions ("by 9am", "by 4:30 pm") BEFORE extraction --
  // otherwise "mill valley by 4pm" becomes the candidate "mill valley 4pm",
  // which fails to geocode. Found live during demo testing: this broke
  // every message using the bot's own suggested "...by 9am" format.
  const withoutDeadline = text.replace(/\bby\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi, " ");
  const cleaned = withoutDeadline.toLowerCase().replace(/[^a-z0-9\s']/g, " ");
  const segments = cleaned.split(/\bto\b|\bfrom\b|\bform\b/);

  const candidates = new Set<string>();
  for (const seg of segments) {
    const words = seg.split(/\s+/).filter((w) => w && !FILLER_WORDS.has(w));
    if (words.length > 0) {
      candidates.add(words.join(" "));
      // Also add a shorter 1-2 word candidate from the end of the segment --
      // place names are usually short, and a long segment (e.g. leftover
      // descriptive words) is less likely to geocode than its tail alone.
      if (words.length > 2) candidates.add(words.slice(-2).join(" "));
    }
  }
  // Also try the whole message filler-stripped, as a fallback.
  const allWords = cleaned.split(/\s+/).filter((w) => w && !FILLER_WORDS.has(w));
  if (allWords.length > 0) candidates.add(allWords.join(" "));

  return [...candidates].sort((a, b) => a.length - b.length);
}

/**
 * Try each candidate place query in order until one actually geocodes to a
 * real place. Returns null (not a fabricated fallback location) if none do.
 */
const SF_CENTER = { lat: 37.7749, lng: -122.4194 };
const MAX_REASONABLE_KM_FROM_SF = 150; // this app only makes sense for Bay Area commutes;
// a geocode that lands 6000km away (e.g. garbage input fuzzy-matching an
// unrelated town somewhere) is more likely a bad match than a real ask.

export async function resolveLocation(
  text: string
): Promise<{ lat: number; lng: number; displayName: string; matchedQuery: string } | null> {
  for (const query of extractPlaceQueries(text)) {
    const result = await geocode(query);
    if (!result) continue;
    if (haversineKm(result.lat, result.lng, SF_CENTER.lat, SF_CENTER.lng) > MAX_REASONABLE_KM_FROM_SF) {
      continue; // reject and try the next candidate query instead of accepting a bad match
    }
    return { ...result, matchedQuery: query };
  }
  return null;
}

let stopsCache: { stops: { id: string; name: string; lat: number; lng: number }[]; fetchedAt: number } | null =
  null;
const STOPS_CACHE_MS = 60 * 60 * 1000; // stop locations don't change; refresh hourly

async function getAllStops(): Promise<{ id: string; name: string; lat: number; lng: number }[]> {
  if (stopsCache && Date.now() - stopsCache.fetchedAt < STOPS_CACHE_MS) return stopsCache.stops;
  if (!FIVE_ELEVEN_TOKEN) return [];
  try {
    const res = await fetch(
      `http://api.511.org/transit/stops?api_key=${FIVE_ELEVEN_TOKEN}&operator_id=SF&format=json`
    );
    if (!res.ok) return stopsCache?.stops ?? [];
    const text = (await res.text()).replace(/^﻿/, "");
    const data = JSON.parse(text);
    const raw = data?.Contents?.dataObjects?.ScheduledStopPoint ?? [];
    const stops = raw
      .filter((s: any) => s.Location?.Latitude && s.Location?.Longitude)
      .map((s: any) => ({
        id: s.id,
        name: s.Name,
        lat: parseFloat(s.Location.Latitude),
        lng: parseFloat(s.Location.Longitude),
      }));
    stopsCache = { stops, fetchedAt: Date.now() };
    return stops;
  } catch {
    return stopsCache?.stops ?? [];
  }
}

/** Find the nearest real SF Muni stop to a location, or null if the nearest
 * one is farther than maxKm (i.e. this location isn't realistically served
 * by this stop -- don't offer a bus option that isn't actually relevant). */
export async function findNearestStop(
  lat: number,
  lng: number,
  maxKm = 2
): Promise<{ id: string; name: string; distanceKm: number } | null> {
  const stops = await getAllStops();
  if (stops.length === 0) return null;
  let nearest = stops[0]!;
  let nearestDist = haversineKm(lat, lng, nearest.lat, nearest.lng);
  for (const s of stops) {
    const d = haversineKm(lat, lng, s.lat, s.lng);
    if (d < nearestDist) {
      nearest = s;
      nearestDist = d;
    }
  }
  if (nearestDist > maxKm) return null;
  return { id: nearest.id, name: nearest.name, distanceKm: nearestDist };
}

/** Find the nearest ferry terminal, or null if farther than maxKm (not a
 * realistic ferry option from this location). */
export function findNearestTerminal(
  lat: number,
  lng: number,
  maxKm = 8
): { terminal: string; distanceKm: number } | null {
  let best: { terminal: string; distanceKm: number } | null = null;
  for (const [name, coords] of Object.entries(FERRY_TERMINALS)) {
    const d = haversineKm(lat, lng, coords.lat, coords.lng);
    if (!best || d < best.distanceKm) best = { terminal: name, distanceKm: d };
  }
  if (!best || best.distanceKm > maxKm) return null;
  return best;
}

/** Live bus/Muni status via 511.org Stop Monitoring API. */
export async function getBusStatus(stopId: string, agency = "SF"): Promise<TransportOption | null> {
  if (!FIVE_ELEVEN_TOKEN) return null;
  try {
    const url = `http://api.511.org/transit/StopMonitoring?api_key=${FIVE_ELEVEN_TOKEN}&agency=${agency}&stopcode=${stopId}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    // 511 responses are UTF-8 with a BOM; strip it before parsing.
    const text = (await res.text()).replace(/^﻿/, "");
    const data = JSON.parse(text);
    const visits =
      data?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit ?? [];
    if (!visits.length) return { mode: "bus", etaMinutes: null, reliability: "no live data", raw: data };

    const next = visits[0].MonitoredVehicleJourney;
    const expected = next?.MonitoredCall?.ExpectedArrivalTime;
    const aimed = next?.MonitoredCall?.AimedArrivalTime;
    let etaMinutes: number | null = null;
    let reliability = "on schedule";
    if (expected) {
      etaMinutes = Math.round((new Date(expected).getTime() - Date.now()) / 60000);
      if (aimed) {
        const delayMin = Math.round(
          (new Date(expected).getTime() - new Date(aimed).getTime()) / 60000
        );
        if (delayMin > 1) reliability = `running ${delayMin} min late`;
        else if (delayMin < -1) reliability = `running ${Math.abs(delayMin)} min early`;
      }
    }
    return { mode: "bus", etaMinutes, reliability, raw: next };
  } catch {
    return null;
  }
}

/**
 * Fixed Golden Gate Ferry weekend schedule (Sausalito/Larkspur/Tiburon -> SF).
 * No live call needed -- ferries run a locked schedule. Source: pulled and
 * verified directly from Golden Gate Ferry / oursausalito.com mirrors.
 */
const FERRY_SCHEDULE: Record<string, string[]> = {
  larkspur: ["09:00", "10:00", "10:45", "11:30", "12:15", "13:30", "14:15", "15:00", "15:45", "16:30", "17:15", "18:00", "18:45"],
  sausalito: ["10:15", "13:55", "15:40", "17:30"],
  tiburon: ["11:50", "12:55", "14:45", "17:10"],
};

export function getFerrySchedule(terminal: "larkspur" | "sausalito" | "tiburon"): TransportOption {
  const times = FERRY_SCHEDULE[terminal] ?? [];
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  let etaMinutes: number | null = null;
  for (const t of times) {
    const [h, m] = t.split(":").map(Number);
    const depMinutes = h * 60 + m;
    if (depMinutes >= nowMinutes) {
      etaMinutes = depMinutes - nowMinutes;
      break;
    }
  }
  return {
    mode: "ferry",
    etaMinutes,
    reliability: "fixed schedule, always on time",
    raw: { terminal, times },
  };
}

/** Live bike/scooter availability via the public GBFS feed (Bay Wheels). Free, no auth. */
export async function getBikeScooterAvailability(
  lat: number,
  lng: number,
  radiusKm = 0.5
): Promise<TransportOption | null> {
  try {
    const res = await fetch("https://gbfs.lyft.com/gbfs/1.1/bay/en/free_bike_status.json");
    if (!res.ok) return null;
    const data = await res.json();
    const bikes: any[] = data?.data?.bikes ?? [];

    const nearby = bikes.filter((b) => {
      if (b.is_disabled || b.is_reserved) return false;
      const dLat = b.lat - lat;
      const dLng = b.lon - lng;
      // Rough km conversion, good enough for "is it nearby" at this scale.
      const distKm = Math.sqrt(dLat ** 2 + dLng ** 2) * 111;
      return distKm <= radiusKm;
    });

    return {
      mode: "bike/scooter",
      etaMinutes: nearby.length > 0 ? 2 : null, // walk-to-vehicle estimate
      reliability: `${nearby.length} available within ${radiusKm}km`,
      raw: nearby.slice(0, 5),
    };
  } catch {
    return null;
  }
}

/** Straight-line distance in km (haversine). Good enough for a rough time
 * estimate over these short urban distances -- not turn-by-turn routing. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const SCOOTER_SPEED_KMH = 15; // typical e-bike/scooter urban speed
const WALK_SPEED_KMH = 4.8;

/**
 * Combo option: walk to the nearest available bike/scooter, ride it to a
 * ferry terminal, then take the next ferry from there. Only returned if a
 * nearby vehicle actually exists (real data, not assumed) and the terminal
 * is within a plausible scooter-ride distance.
 */
export async function getScooterToFerryCombo(
  userLat: number,
  userLng: number,
  terminal: "larkspur" | "sausalito" | "tiburon",
  terminalLat: number,
  terminalLng: number
): Promise<TransportOption | null> {
  try {
    const res = await fetch("https://gbfs.lyft.com/gbfs/1.1/bay/en/free_bike_status.json");
    if (!res.ok) return null;
    const data = await res.json();
    const bikes: any[] = data?.data?.bikes ?? [];
    const usable = bikes.filter((b) => !b.is_disabled && !b.is_reserved);
    if (usable.length === 0) return null;

    // Nearest available vehicle to the user right now.
    let nearest = usable[0];
    let nearestDist = haversineKm(userLat, userLng, nearest.lat, nearest.lon);
    for (const b of usable) {
      const d = haversineKm(userLat, userLng, b.lat, b.lon);
      if (d < nearestDist) {
        nearest = b;
        nearestDist = d;
      }
    }

    const rideDistKm = haversineKm(nearest.lat, nearest.lon, terminalLat, terminalLng);
    if (rideDistKm > 6) return null; // too far to be a realistic scooter leg

    const walkToVehicleMin = (nearestDist / WALK_SPEED_KMH) * 60;
    const rideMin = (rideDistKm / SCOOTER_SPEED_KMH) * 60;

    const ferry = getFerrySchedule(terminal);
    if (ferry.etaMinutes === null) return null;

    const arriveAtTerminalMin = walkToVehicleMin + rideMin;
    // Only a real combo if you'd actually make the ferry with a little buffer.
    if (arriveAtTerminalMin > ferry.etaMinutes - 3) return null;

    return {
      mode: `scooter->${terminal} ferry`,
      etaMinutes: ferry.etaMinutes,
      reliability: `${Math.round(walkToVehicleMin)} min walk + ${Math.round(rideMin)} min ride to catch a fixed-schedule ferry`,
      raw: { nearest, rideDistKm, ferry },
    };
  } catch {
    return null;
  }
}
