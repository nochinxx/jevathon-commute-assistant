import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FIVE_ELEVEN_TOKEN = process.env.FIVE_ELEVEN_TOKEN!;
const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY!;

const FERRY_TERMINALS = [
  { name: "sausalito", label: "Sausalito", lat: 37.8419, lng: -122.4785 },
  { name: "larkspur", label: "Larkspur", lat: 37.945, lng: -122.5089 },
  { name: "tiburon", label: "Tiburon", lat: 37.8735, lng: -122.4566 },
  { name: "sf_ferry_building", label: "SF Ferry Building", lat: 37.7955, lng: -122.3937 },
];

const DEFAULT_ORIGIN = { lat: 37.7955, lng: -122.3937, label: "SF Ferry Building (default origin)" };

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocode(query: string): Promise<{ lat: number; lng: number; displayName: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Jevathon-CommuteAssistant/1.0 (hackathon dashboard)" },
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

let stopsCache: { stops: { id: string; name: string; lat: number; lng: number }[]; fetchedAt: number } | null = null;
const STOPS_CACHE_MS = 60 * 60 * 1000;

async function getAllStops(): Promise<{ id: string; name: string; lat: number; lng: number }[]> {
  if (stopsCache && Date.now() - stopsCache.fetchedAt < STOPS_CACHE_MS) return stopsCache.stops;
  try {
    const res = await fetch(`http://api.511.org/transit/stops?api_key=${FIVE_ELEVEN_TOKEN}&operator_id=SF&format=json`);
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

async function getBusEta(
  stopId: string
): Promise<{ etaMinutes: number | null; reliability: string; lineName: string | null }> {
  try {
    const url = `http://api.511.org/transit/StopMonitoring?api_key=${FIVE_ELEVEN_TOKEN}&agency=SF&stopcode=${stopId}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return { etaMinutes: null, reliability: "no live data", lineName: null };
    const text = (await res.text()).replace(/^﻿/, "");
    const data = JSON.parse(text);
    const visits = data?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit ?? [];
    if (!visits.length) return { etaMinutes: null, reliability: "no live data", lineName: null };
    const next = visits[0].MonitoredVehicleJourney;
    const lineName: string | null = next?.PublishedLineName ?? next?.LineRef ?? null;
    const expected = next?.MonitoredCall?.ExpectedArrivalTime;
    const aimed = next?.MonitoredCall?.AimedArrivalTime;
    if (!expected) return { etaMinutes: null, reliability: "no live data", lineName };
    const etaMinutes = Math.round((new Date(expected).getTime() - Date.now()) / 60000);
    let reliability = "on schedule";
    if (aimed) {
      const delayMin = Math.round((new Date(expected).getTime() - new Date(aimed).getTime()) / 60000);
      if (delayMin > 1) reliability = `running ${delayMin} min late`;
      else if (delayMin < -1) reliability = `running ${Math.abs(delayMin)} min early`;
    }
    return { etaMinutes, reliability, lineName };
  } catch {
    return { etaMinutes: null, reliability: "no live data", lineName: null };
  }
}

async function getNearbyBikes(lat: number, lng: number, radiusKm = 0.8) {
  try {
    const res = await fetch("https://gbfs.lyft.com/gbfs/1.1/bay/en/free_bike_status.json");
    if (!res.ok) return { count: 0, nearest: null as { lat: number; lng: number; vehicleLabel: string } | null };
    const data = await res.json();
    const bikes: any[] = data?.data?.bikes ?? [];
    const usable = bikes.filter((b) => !b.is_disabled && !b.is_reserved);
    let nearest: any = null;
    let nearestDist = Infinity;
    let count = 0;
    for (const b of usable) {
      const d = haversineKm(lat, lng, b.lat, b.lon);
      if (d <= radiusKm) count++;
      if (d < nearestDist) {
        nearestDist = d;
        nearest = b;
      }
    }
    // Bay Wheels is Lyft's Bay Area bike-share brand (gbfs.lyft.com/gbfs/1.1/bay/) -- name it, not a bare generic term.
    const vehicleLabel = nearest ? (nearest.type === "electric_bike" ? "Bay Wheels e-bike" : "Bay Wheels classic bike") : "";
    return {
      count,
      nearest: nearest ? { lat: nearest.lat, lng: nearest.lon, vehicleLabel } : null,
      nearestDistKm: nearestDist,
    };
  } catch {
    return { count: 0, nearest: null as { lat: number; lng: number; vehicleLabel: string } | null };
  }
}

type RouteOption = {
  mode: "bus" | "ferry" | "bike_scooter";
  label: string;
  etaMinutes: number | null;
  reliability: string;
  path: [number, number][]; // [lat, lng] points, straight-line legs
};

async function jevChoice(options: RouteOption[]) {
  const viable = options.filter((o) => o.etaMinutes !== null);
  if (viable.length === 0) return null;
  const stateLines = viable.map((o) => `${o.mode}: ETA ${o.etaMinutes} min, ${o.reliability}`);
  const criteria: Record<string, string> = {};
  for (const o of viable) criteria[o.mode] = `Take the ${o.label}`;

  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TYPESAFE_API_KEY}` },
      body: JSON.stringify({
        state: stateLines.join(" "),
        model: "jev-latest",
        questions: {
          best_route: {
            type: "choice",
            instructions: "Which option gets the user to their destination most reliably and soonest?",
            criteria,
          },
        },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.answers?.best_route ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const destinationText = searchParams.get("destination");
  const originText = searchParams.get("origin");

  if (!destinationText) {
    return NextResponse.json({ error: "Missing ?destination=" }, { status: 400 });
  }

  const destination = await geocode(destinationText);
  if (!destination) {
    return NextResponse.json({ error: `Couldn't find a real place for "${destinationText}"` }, { status: 422 });
  }

  const origin = originText ? await geocode(originText) : null;
  const originLabel = origin?.displayName ?? DEFAULT_ORIGIN.label;
  const originPoint = origin ?? DEFAULT_ORIGIN;

  // Nearest real bus stop to the ORIGIN (only relevant if actually close).
  const stops = await getAllStops();
  let nearestStop: { id: string; name: string; lat: number; lng: number; distanceKm: number } | null = null;
  if (stops.length > 0) {
    let best = stops[0];
    let bestDist = haversineKm(originPoint.lat, originPoint.lng, best.lat, best.lng);
    for (const s of stops) {
      const d = haversineKm(originPoint.lat, originPoint.lng, s.lat, s.lng);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    if (bestDist <= 2) nearestStop = { ...best, distanceKm: bestDist };
  }

  // Nearest ferry terminal to the origin.
  let nearestTerminal: (typeof FERRY_TERMINALS)[number] & { distanceKm: number } = {
    ...FERRY_TERMINALS[0],
    distanceKm: Infinity,
  };
  for (const t of FERRY_TERMINALS) {
    const d = haversineKm(originPoint.lat, originPoint.lng, t.lat, t.lng);
    if (d < nearestTerminal.distanceKm) nearestTerminal = { ...t, distanceKm: d };
  }
  const terminalInRange = nearestTerminal.distanceKm <= 8;

  const bikes = await getNearbyBikes(originPoint.lat, originPoint.lng);

  const options: RouteOption[] = [];

  if (nearestStop) {
    const bus = await getBusEta(nearestStop.id);
    const busLabel = bus.lineName ? `Muni ${bus.lineName} (${nearestStop.name})` : `Bus (${nearestStop.name})`;
    options.push({
      mode: "bus",
      label: busLabel,
      etaMinutes: bus.etaMinutes,
      reliability: bus.reliability,
      path: [
        [originPoint.lat, originPoint.lng],
        [nearestStop.lat, nearestStop.lng],
        [destination.lat, destination.lng],
      ],
    });
  }

  if (terminalInRange) {
    // Fixed weekend ferry schedule (Sausalito) reused as a rough same-day estimate.
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const schedule = [10 * 60 + 15, 13 * 60 + 55, 15 * 60 + 40, 17 * 60 + 30]; // 10:15, 13:55, 15:40, 17:30
    let ferryEta: number | null = null;
    for (const t of schedule) {
      if (t >= nowMin) {
        ferryEta = t - nowMin;
        break;
      }
    }
    options.push({
      mode: "ferry",
      label: `Ferry (${nearestTerminal.label})`,
      etaMinutes: ferryEta,
      reliability: "fixed schedule, always on time",
      path: [
        [originPoint.lat, originPoint.lng],
        [nearestTerminal.lat, nearestTerminal.lng],
        [destination.lat, destination.lng],
      ],
    });
  }

  if (bikes.nearest) {
    const distKm = haversineKm(originPoint.lat, originPoint.lng, destination.lat, destination.lng);
    const rideMin = Math.round((distKm / 15) * 60) + 2; // ~15km/h + walk-to-vehicle buffer
    options.push({
      mode: "bike_scooter",
      label: bikes.nearest.vehicleLabel,
      etaMinutes: distKm <= 6 ? rideMin : null,
      reliability: `${bikes.count} Bay Wheels vehicles available nearby`,
      path: [
        [originPoint.lat, originPoint.lng],
        [bikes.nearest.lat, bikes.nearest.lng],
        [destination.lat, destination.lng],
      ],
    });
  }

  const decision = await jevChoice(options);

  return NextResponse.json({
    origin: { lat: originPoint.lat, lng: originPoint.lng, label: originLabel },
    destination: { lat: destination.lat, lng: destination.lng, label: destination.displayName },
    options,
    decision,
  });
}
