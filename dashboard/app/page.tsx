"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { MapNode } from "./components/MapView";

const MapView = dynamic(() => import("./components/MapView"), { ssr: false });

type LiveData = {
  fetchedAt: string;
  counts: { bus: number; bikeScooter: number; ferry: number; traffic: number };
  nodes: MapNode[];
  jevSample: { choice: string; confidence: number; probabilities: Record<string, number> } | null;
};

const MODE_LABEL: Record<string, string> = {
  bus: "Bus",
  bike_scooter: "Bike / Scooter",
  ferry: "Ferry",
};

export default function Home() {
  const [data, setData] = useState<LiveData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        const json = await res.json();
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch {
        // keep last good data on transient failure
      }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex h-screen w-screen bg-slate-950 text-slate-100">
      <div className="flex-1 relative">
        {data && data.nodes.length > 0 ? (
          <MapView nodes={data.nodes} />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-slate-400">
            {loading ? "Loading live transit data…" : "No live nodes right now"}
          </div>
        )}
      </div>

      <aside className="w-96 shrink-0 border-l border-slate-800 p-6 overflow-y-auto">
        <h1 className="text-xl font-semibold tracking-tight">Commute Copilot</h1>
        <p className="text-sm text-slate-400 mt-1">
          Live San Francisco transit, powered by Jev
        </p>

        <div className="mt-6 text-xs text-slate-500">
          {data ? `Last updated: ${new Date(data.fetchedAt).toLocaleTimeString()}` : "Connecting…"}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <StatTile label="Buses" value={data?.counts.bus} color="#2563eb" />
          <StatTile label="Bikes/Scooters" value={data?.counts.bikeScooter} color="#16a34a" />
          <StatTile label="Ferry terminals" value={data?.counts.ferry} color="#ea580c" />
          <StatTile label="Traffic events" value={data?.counts.traffic} color="#dc2626" />
        </div>

        <MapsComparisonPanel />

        <div className="mt-8">
          <h2 className="text-sm font-medium text-slate-300 uppercase tracking-wide">
            Jev decision (sample)
          </h2>
          {data?.jevSample ? (
            <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
              <div className="text-lg font-semibold">
                Take the {MODE_LABEL[data.jevSample.choice] ?? data.jevSample.choice}
              </div>
              <div className="text-sm text-slate-400 mt-1">
                Confidence: {(data.jevSample.confidence * 100).toFixed(0)}%
              </div>
              <div className="mt-3 space-y-2">
                {Object.entries(data.jevSample.probabilities).map(([mode, p]) => (
                  <div key={mode}>
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>{MODE_LABEL[mode] ?? mode}</span>
                      <span>{(p * 100).toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-slate-300"
                        style={{ width: `${p * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm text-slate-500">Waiting for Jev…</div>
          )}
        </div>

        <div className="mt-8 text-xs text-slate-600 leading-relaxed">
          Bus positions: 511.org Vehicle Monitoring (live GPS). Bike/scooter positions: GBFS
          free_bike_status feed (Bay Wheels, public, no auth). Ferry: fixed Golden Gate Ferry
          schedule. All data sources are independently verifiable at their public endpoints.
        </div>
      </aside>
    </div>
  );
}

type MapsComparison = { recommendedMode: string; etaMinutes: number | null; raw: string };

function MapsComparisonPanel() {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [comparison, setComparison] = useState<MapsComparison | null>(null);

  async function fetchComparison() {
    setState("loading");
    try {
      const res = await fetch("/api/maps-comparison", { cache: "no-store" });
      if (!res.ok) throw new Error("bad response");
      const json = await res.json();
      if (!json || json.error) throw new Error("no data");
      setComparison(json);
      setState("ok");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    fetchComparison();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-300 uppercase tracking-wide">
          vs. Google Maps
        </h2>
        <button
          onClick={fetchComparison}
          className="text-xs text-slate-400 hover:text-slate-200 border border-slate-700 rounded px-2 py-1"
          disabled={state === "loading"}
        >
          {state === "loading" ? "Checking…" : "Refresh"}
        </button>
      </div>
      {state === "error" && (
        <div className="mt-2 text-sm text-slate-500">Comparison unavailable right now.</div>
      )}
      {state === "ok" && comparison && (
        <div className="mt-2 text-sm text-slate-300">
          Maps says: <span className="font-semibold">{comparison.recommendedMode}</span>
          {comparison.etaMinutes != null && <> — {comparison.etaMinutes} min</>}
        </div>
      )}
      {state === "loading" && !comparison && (
        <div className="mt-2 text-sm text-slate-500">Asking Google Maps (Sausalito → Ferry Building)…</div>
      )}
    </div>
  );
}

function StatTile({ label, value, color }: { label: string; value?: number; color: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
      <div className="text-2xl font-semibold" style={{ color }}>
        {value ?? "–"}
      </div>
      <div className="text-[11px] text-slate-500 mt-1 leading-tight">{label}</div>
    </div>
  );
}
