"use client";

import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type MapNode = {
  id: string;
  mode: "bus" | "bike-scooter" | "ferry";
  lat: number;
  lng: number;
  label: string;
};

const STYLE: Record<MapNode["mode"], { color: string; size: number; symbol: string }> = {
  bus: { color: "#2563eb", size: 14, symbol: "B" },
  "bike-scooter": { color: "#16a34a", size: 12, symbol: "•" },
  ferry: { color: "#ea580c", size: 20, symbol: "F" },
};

function iconFor(mode: MapNode["mode"]) {
  const s = STYLE[mode];
  return L.divIcon({
    className: "",
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

export default function MapView({ nodes }: { nodes: MapNode[] }) {
  return (
    <MapContainer
      center={[37.7749, -122.4194]}
      zoom={13}
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        attribution='&copy; OpenStreetMap contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {nodes.map((n) => (
        <Marker key={n.id} position={[n.lat, n.lng]} icon={iconFor(n.mode)}>
          <Popup>{n.label}</Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
