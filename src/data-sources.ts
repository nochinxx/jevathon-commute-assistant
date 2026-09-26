// Normalized multi-modal transport data layer.
// Each function returns { mode, etaMinutes, reliability, raw } or null on failure.

type TransportOption = {
  mode: string;
  etaMinutes: number | null;
  reliability: string; // short human description
  raw: unknown;
};

const FIVE_ELEVEN_TOKEN = process.env.FIVE_ELEVEN_TOKEN;

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
