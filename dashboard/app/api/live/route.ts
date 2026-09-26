import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FIVE_ELEVEN_TOKEN = process.env.FIVE_ELEVEN_TOKEN!;

type MapNode = {
  id: string;
  mode: "bus" | "bike-scooter" | "ferry" | "traffic";
  lat: number;
  lng: number;
  label: string;
};

// Fixed ferry terminal locations (SF Bay Area, verified coordinates).
const FERRY_TERMINALS = [
  { id: "ferry-sf", name: "San Francisco Ferry Building", lat: 37.7955, lng: -122.3937 },
  { id: "ferry-sausalito", name: "Sausalito", lat: 37.8419, lng: -122.4785 },
  { id: "ferry-larkspur", name: "Larkspur", lat: 37.945, lng: -122.5089 },
  { id: "ferry-tiburon", name: "Tiburon", lat: 37.8735, lng: -122.4566 },
];

// 511.org's free token allows 60 requests/hour -- with no server-side cache,
// the dashboard's own 5s client polling alone burns through that in a few
// minutes (confirmed live: "The allowed number of requests 60 per 3600
// seconds has been exceeded" on both of these two endpoints). Cache each
// independently so real calls to 511 stay well under quota regardless of how
// many tabs are polling, leaving headroom for on-demand StopMonitoring calls
// from actual trip requests, which matter more than the ambient map.
const CACHE_MS = 180_000;
let vehiclesCache: { data: MapNode[]; expiresAt: number } | null = null;
let trafficCache: { data: MapNode[]; expiresAt: number } | null = null;

async function getLiveVehicles(): Promise<MapNode[]> {
  if (vehiclesCache && vehiclesCache.expiresAt > Date.now()) return vehiclesCache.data;
  try {
    const res = await fetch(
      `http://api.511.org/transit/VehicleMonitoring?api_key=${FIVE_ELEVEN_TOKEN}&agency=SF&format=json`,
    );
    if (!res.ok) return vehiclesCache?.data ?? [];
    // Let fetch handle decompression transparently (matches how the working
    // GBFS call is written) -- manually requesting gzip and hand-decoding the
    // raw bytes was fragile and behaved differently across runtimes.
    const text = (await res.text()).replace(/^﻿/, "");
    const data = JSON.parse(text);
    const activities =
      data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.VehicleActivity ?? [];
    const vehicles = activities
      .filter((a: any) => a.MonitoredVehicleJourney?.VehicleLocation?.Latitude)
      .slice(0, 200)
      .map((a: any) => {
        const j = a.MonitoredVehicleJourney;
        return {
          id: `bus-${j.VehicleRef}-${j.LineRef}`,
          mode: "bus" as const,
          lat: parseFloat(j.VehicleLocation.Latitude),
          lng: parseFloat(j.VehicleLocation.Longitude),
          label: `${j.PublishedLineName ?? j.LineRef} -> ${j.DestinationName ?? "?"}`,
        };
      });
    vehiclesCache = { data: vehicles, expiresAt: Date.now() + CACHE_MS };
    return vehicles;
  } catch {
    return vehiclesCache?.data ?? [];
  }
}

async function getLiveBikesScooters(): Promise<MapNode[]> {
  try {
    const res = await fetch("https://gbfs.lyft.com/gbfs/1.1/bay/en/free_bike_status.json");
    if (!res.ok) return [];
    const data = await res.json();
    const bikes: any[] = data?.data?.bikes ?? [];
    // Only show SF-area ones so the map isn't swamped with the whole Bay Area feed.
    return bikes
      .filter((b) => !b.is_disabled && !b.is_reserved)
      .filter((b) => b.lat > 37.7 && b.lat < 37.83 && b.lon > -122.52 && b.lon < -122.36)
      .slice(0, 150)
      .map((b) => ({
        id: `vehicle-${b.bike_id}`,
        mode: "bike-scooter" as const,
        lat: b.lat,
        lng: b.lon,
        label: b.type === "electric_bike" ? "Bay Wheels e-bike" : "Bay Wheels classic bike",
      }));
  } catch {
    return [];
  }
}

async function getTrafficEvents(): Promise<MapNode[]> {
  if (trafficCache && trafficCache.expiresAt > Date.now()) return trafficCache.data;
  try {
    const res = await fetch(
      `http://api.511.org/traffic/events?api_key=${FIVE_ELEVEN_TOKEN}&format=json`,
    );
    if (!res.ok) return trafficCache?.data ?? [];
    // Let fetch handle decompression transparently (matches how the working
    // GBFS call is written) -- manually requesting gzip and hand-decoding the
    // raw bytes was fragile and behaved differently across runtimes.
    const text = (await res.text()).replace(/^﻿/, "");
    const data = JSON.parse(text);
    const events: any[] = data?.events ?? [];
    const trafficEvents = events
      .filter((e) => e.status === "ACTIVE" && Array.isArray(e.geography?.coordinates))
      .slice(0, 30)
      .map((e) => {
        const [lng, lat] = e.geography.coordinates;
        const headline: string = e.headline ?? e.event_type ?? "Traffic event";
        return {
          id: `traffic-${e.id}`,
          mode: "traffic" as const,
          lat,
          lng,
          label: headline.length > 140 ? headline.slice(0, 140) + "…" : headline,
        };
      });
    trafficCache = { data: trafficEvents, expiresAt: Date.now() + CACHE_MS };
    return trafficEvents;
  } catch {
    return trafficCache?.data ?? [];
  }
}

function getFerryNodes(): MapNode[] {
  return FERRY_TERMINALS.map((t) => ({
    id: t.id,
    mode: "ferry" as const,
    lat: t.lat,
    lng: t.lng,
    label: t.name,
  }));
}

export async function GET() {
  const [vehicles, bikesScooters, trafficEvents] = await Promise.all([
    getLiveVehicles(),
    getLiveBikesScooters(),
    getTrafficEvents(),
  ]);
  const nodes = [...vehicles, ...bikesScooters, ...trafficEvents, ...getFerryNodes()];

  return NextResponse.json({
    fetchedAt: new Date().toISOString(),
    counts: {
      bus: vehicles.length,
      bikeScooter: bikesScooters.length,
      ferry: FERRY_TERMINALS.length,
      traffic: trafficEvents.length,
    },
    nodes,
  });
}
