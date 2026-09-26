import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FIVE_ELEVEN_TOKEN = process.env.FIVE_ELEVEN_TOKEN!;
const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY!;

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

async function getLiveVehicles(): Promise<MapNode[]> {
  try {
    const res = await fetch(
      `http://api.511.org/transit/VehicleMonitoring?api_key=${FIVE_ELEVEN_TOKEN}&agency=SF&format=json`,
    );
    if (!res.ok) return [];
    // Let fetch handle decompression transparently (matches how the working
    // GBFS call is written) -- manually requesting gzip and hand-decoding the
    // raw bytes was fragile and behaved differently across runtimes.
    const text = (await res.text()).replace(/^﻿/, "");
    const data = JSON.parse(text);
    const activities =
      data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.VehicleActivity ?? [];
    return activities
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
  } catch {
    return [];
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
        label: b.type === "electric_bike" ? "E-bike" : "Bike/scooter",
      }));
  } catch {
    return [];
  }
}

async function getTrafficEvents(): Promise<MapNode[]> {
  try {
    const res = await fetch(
      `http://api.511.org/traffic/events?api_key=${FIVE_ELEVEN_TOKEN}&format=json`,
    );
    if (!res.ok) return [];
    // Let fetch handle decompression transparently (matches how the working
    // GBFS call is written) -- manually requesting gzip and hand-decoding the
    // raw bytes was fragile and behaved differently across runtimes.
    const text = (await res.text()).replace(/^﻿/, "");
    const data = JSON.parse(text);
    const events: any[] = data?.events ?? [];
    return events
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
  } catch {
    return [];
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

async function getJevSample() {
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TYPESAFE_API_KEY}`,
      },
      body: JSON.stringify({
        state:
          "bus: ETA 6 min, running on time. ferry: ETA 20 min, fixed schedule, always on time. bike_scooter: ETA 2 min walk, 42 available nearby.",
        model: "jev-latest",
        questions: {
          best_route: {
            type: "choice",
            instructions: "Which option gets the user there most reliably and soonest?",
            criteria: { bus: "Take the bus", ferry: "Take the ferry", bike_scooter: "Take a bike or scooter" },
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

export async function GET() {
  const [vehicles, bikesScooters, trafficEvents, jevSample] = await Promise.all([
    getLiveVehicles(),
    getLiveBikesScooters(),
    getTrafficEvents(),
    getJevSample(),
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
    jevSample,
  });
}
