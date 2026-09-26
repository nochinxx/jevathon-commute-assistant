"use client";

import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type MapNode = {
  id: string;
  mode: "bus" | "bike-scooter" | "ferry" | "traffic";
  lat: number;
  lng: number;
  label: string;
};

export type RoutePath = {
  mode: "bus" | "ferry" | "bike_scooter";
  points: [number, number][];
  isChosen: boolean;
};

const STYLE: Record<MapNode["mode"], { color: string; size: number; symbol: string; shape: "circle" | "triangle" }> = {
  bus: { color: "#2563eb", size: 14, symbol: "B", shape: "circle" },
  "bike-scooter": { color: "#16a34a", size: 12, symbol: "•", shape: "circle" },
  ferry: { color: "#ea580c", size: 20, symbol: "F", shape: "circle" },
  traffic: { color: "#dc2626", size: 16, symbol: "!", shape: "triangle" },
};

const ROUTE_COLOR: Record<RoutePath["mode"], string> = {
  bus: "#2563eb",
  ferry: "#ea580c",
  bike_scooter: "#16a34a",
};
const CHOSEN_COLOR = "#22ff88";

function iconFor(mode: MapNode["mode"]) {
  const s = STYLE[mode];
  if (s.shape === "triangle") {
    return L.divIcon({
      className: "marker-anim",
      html: `<div style="
        width:0;height:0;
        border-left:${s.size / 2}px solid transparent;
        border-right:${s.size / 2}px solid transparent;
        border-bottom:${s.size}px solid ${s.color};
        filter:drop-shadow(0 0 2px rgba(0,0,0,0.6));
        position:relative;
      "><span style="
        position:absolute;top:${s.size * 0.4}px;left:50%;transform:translateX(-50%);
        color:white;font-size:${s.size * 0.5}px;font-weight:800;font-family:sans-serif;
      ">${s.symbol}</span></div>`,
      iconSize: [s.size, s.size],
      iconAnchor: [s.size / 2, s.size],
    });
  }
  return L.divIcon({
    className: "marker-anim",
    html: `<div style="
      width:${s.size}px;height:${s.size}px;border-radius:50%;
      background:${s.color};border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.4);
      display:flex;align-items:center;justify-content:center;
      color:white;font-size:${s.size * 0.55}px;font-weight:700;font-family:sans-serif;
    ">${s.symbol}</div>`,
    iconSize: [s.size, s.size],
    iconAnchor: [s.size / 2, s.size / 2],
  });
}

/**
 * Smoothly moves a marker to a new position instead of snapping. Leaflet
 * markers don't animate position changes on their own -- setLatLng() jumps
 * instantly -- so this interpolates in small steps over ~duration ms
 * whenever the target position changes. Lightweight (no animation library),
 * just enough for a judge to see vehicles actually move between polls
 * instead of teleporting every 5s.
 */
function AnimatedMarker({
  id,
  position,
  icon,
  label,
  duration = 4500,
}: {
  id: string;
  position: [number, number];
  icon: L.DivIcon;
  label: string;
  duration?: number;
}) {
  const markerRef = useRef<L.Marker | null>(null);
  const prevPos = useRef<[number, number]>(position);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const from = prevPos.current;
    const to = position;
    if (from[0] === to[0] && from[1] === to[1]) return;

    const start = performance.now();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    function step(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 2); // ease-out
      const lat = from[0] + (to[0] - from[0]) * eased;
      const lng = from[1] + (to[1] - from[1]) * eased;
      marker?.setLatLng([lat, lng]);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        prevPos.current = to;
      }
    }
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position[0], position[1]]);

  return (
    <Marker ref={markerRef} position={prevPos.current} icon={icon}>
      <Popup>{label}</Popup>
    </Marker>
  );
}

export default function MapView({ nodes, routes }: { nodes: MapNode[]; routes?: RoutePath[] }) {
  return (
    <MapContainer center={[37.7749, -122.4194]} zoom={13} style={{ height: "100%", width: "100%" }}>
      <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

      {routes?.map((r, i) => (
        <Polyline
          key={`route-${i}`}
          positions={r.points}
          pathOptions={{
            color: r.isChosen ? CHOSEN_COLOR : ROUTE_COLOR[r.mode],
            weight: r.isChosen ? 6 : 3,
            opacity: r.isChosen ? 0.95 : 0.55,
            dashArray: r.isChosen ? undefined : "6 6",
          }}
        />
      ))}

      {nodes.map((n) =>
        n.mode === "bus" || n.mode === "bike-scooter" ? (
          <AnimatedMarker key={n.id} id={n.id} position={[n.lat, n.lng]} icon={iconFor(n.mode)} label={n.label} />
        ) : (
          <Marker key={n.id} position={[n.lat, n.lng]} icon={iconFor(n.mode)}>
            <Popup>{n.label}</Popup>
          </Marker>
        )
      )}
    </MapContainer>
  );
}
