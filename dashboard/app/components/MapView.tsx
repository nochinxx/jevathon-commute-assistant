"use client";

import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type MapNode = {
  id: string;
  mode: "bus" | "bike-scooter" | "ferry" | "traffic";
  lat: number;
  lng: number;
  label: string;
};

const STYLE: Record<MapNode["mode"], { color: string; size: number; symbol: string; shape: "circle" | "triangle" }> = {
  bus: { color: "#2563eb", size: 14, symbol: "B", shape: "circle" },
  "bike-scooter": { color: "#16a34a", size: 12, symbol: "•", shape: "circle" },
  ferry: { color: "#ea580c", size: 20, symbol: "F", shape: "circle" },
  traffic: { color: "#dc2626", size: 16, symbol: "!", shape: "triangle" },
};

function iconFor(mode: MapNode["mode"]) {
  const s = STYLE[mode];
  if (s.shape === "triangle") {
    return L.divIcon({
      className: "",
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
