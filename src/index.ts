import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import {
  getBusStatus,
  getFerrySchedule,
  getBikeScooterAvailability,
  getScooterToFerryCombo,
  resolveLocation,
  findNearestStop,
  findNearestTerminal,
  FERRY_TERMINALS,
} from "./data-sources.js";
import { decide } from "./jev.js";

type TransportOption = {
  mode: string;
  etaMinutes: number | null;
  reliability: string;
  raw: unknown;
};

/** Turn the winning option into a natural, friend-texting-you sentence
 * instead of a raw mode label -- uses the real computed numbers already
 * on the option (eta, reliability text), not a template restating the
 * mode name. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function narrate(option: TransportOption | undefined, confidence: number): string {
  if (!option) return "Couldn't match Jev's pick back to a specific option -- try again.";
  const pct = (confidence * 100).toFixed(0);

  if (option.mode === "bus") {
    return `Hop on the bus -- it's about ${option.etaMinutes} min out and ${option.reliability} (${pct}% confidence this is your best bet).`;
  }
  if (option.mode === "ferry") {
    const terminal = cap((option.raw as any)?.terminal ?? "the terminal");
    return `Catch the ${terminal} ferry -- it leaves in ${option.etaMinutes} min, ${option.reliability} (${pct}% confidence).`;
  }
  if (option.mode === "bike/scooter") {
    return `Grab a bike or scooter -- ${option.reliability}, about a ${option.etaMinutes} min walk to reach one (${pct}% confidence).`;
  }
  if (option.mode.startsWith("scooter->")) {
    const terminal = cap(option.mode.replace("scooter->", "").replace(" ferry", ""));
    return `Grab a scooter and head to the ${terminal} terminal -- ${option.reliability}. Ferry departs in ${option.etaMinutes} min (${pct}% confidence).`;
  }
  return `Take the ${option.mode.replace(/_/g, " ")} -- ${option.reliability} (${pct}% confidence).`;
}

// Spectrum bridges a single agent loop to many messaging interfaces.
// Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

const trackedGoals = new Map<string, string>(); // spaceId -> last stated goal, per conversation

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  const text = message.content.text.trim();

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const looksLikeGoal = wordCount >= 3;
  if (looksLikeGoal) {
    trackedGoals.set(space.id, text);
  }
  const goal = trackedGoals.get(space.id);

  if (!goal) {
    await space.send(
      "Where are you headed, and by when? (e.g. \"heading to the city, need to be at Embarcadero by 9am\")"
    );
    continue;
  }

  // Real geocoding from what the user actually said -- no hardcoded/demo
  // location. If nothing in the message resolves to a real place, say so
  // honestly instead of silently falling back to a fabricated location.
  const location = await resolveLocation(goal);
  if (!location) {
    await space.send(
      `Couldn't figure out a specific place from that. Try naming a city or neighborhood (e.g. "Sausalito" or "Mill Valley").`
    );
    continue;
  }

  await space.send(`Based on: ${location.displayName} — checking your options...`);

  const nearestTerminal = findNearestTerminal(location.lat, location.lng);
  const nearestStop = await findNearestStop(location.lat, location.lng);

  const terminalCoords = nearestTerminal ? FERRY_TERMINALS[nearestTerminal.terminal] : null;

  const [bus, bike, ferry, combo] = await Promise.all([
    nearestStop ? getBusStatus(nearestStop.id) : Promise.resolve(null),
    getBikeScooterAvailability(location.lat, location.lng),
    nearestTerminal ? Promise.resolve(getFerrySchedule(nearestTerminal.terminal as any)) : Promise.resolve(null),
    nearestTerminal && terminalCoords
      ? getScooterToFerryCombo(
          location.lat,
          location.lng,
          nearestTerminal.terminal as any,
          terminalCoords.lat,
          terminalCoords.lng
        )
      : Promise.resolve(null),
  ]);

  const options = [bus, ferry, bike, combo].filter(
    (o): o is NonNullable<typeof o> => o !== null
  );

  // Be transparent about what was and wasn't considered relevant, and why --
  // this is the "where are you calculating my position" answer, up front.
  const relevanceNotes: string[] = [];
  if (nearestStop) relevanceNotes.push(`nearest bus stop: ${nearestStop.name} (${nearestStop.distanceKm.toFixed(1)}km)`);
  else relevanceNotes.push("no SF Muni stop close enough to be relevant");
  if (nearestTerminal) relevanceNotes.push(`nearest ferry terminal: ${nearestTerminal.terminal} (${nearestTerminal.distanceKm.toFixed(1)}km)`);
  else relevanceNotes.push("no ferry terminal close enough to be relevant");

  if (options.length === 0) {
    await space.send(
      `No viable live options near ${location.displayName} right now (${relevanceNotes.join(", ")}).`
    );
    continue;
  }

  const decision = await decide(options, {
    what: goal,
    whenISO: "",
    where: location.displayName,
  });

  if (!decision) {
    const summary = options
      .map((o) => `${o.mode}: ${o.etaMinutes ?? "?"} min (${o.reliability})`)
      .join("\n");
    await space.send(`Here's what I found (Jev call failed, raw data):\n${summary}`);
    continue;
  }

  const winner = options.find((o) => o.mode.replace(/[^a-zA-Z0-9]/g, "_") === decision.choice);
  const probsLine = Object.entries(decision.probabilities)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${(v * 100).toFixed(0)}%`)
    .join(", ");

  await space.send(
    `${narrate(winner, decision.confidence)}\n\n(${probsLine} — ${relevanceNotes.join(", ")})`
  );
}
