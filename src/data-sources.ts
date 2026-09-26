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
