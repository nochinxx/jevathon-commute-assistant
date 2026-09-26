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

// Fixed starting point for this demo: the CodeRabbit office (201 Spear St,
// SF), geocoded for real via Nominatim. This is where the user is actually
// boarding transit from -- a place name mentioned in the message is the
// destination, not a stand-in for "where you are" (that was the earlier bug).
const ORIGIN_LAT = 37.7912408;
const ORIGIN_LNG = -122.3919786;
const ORIGIN_LABEL = "the CodeRabbit office (201 Spear St)";

/** Extract a stated deadline like "by 9am" / "by 9:30 pm" from free text and
 * return a real ISO timestamp for today (or tomorrow if that time already
 * passed today) -- or null if no time was stated. Returning null and saying
 * so honestly beats fabricating a deadline that was never actually said. */
function extractDeadlineISO(text: string): string | null {
  const match = text.match(/\bby\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  return match ? timeMatchToISO(match) : null;
}

/** Looser than extractDeadlineISO -- accepts a bare time with no "by" prefix
 * (e.g. a one-word reply of "9am" to a direct "what time?" question). */
function extractBareTimeISO(text: string): string | null {
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ?? text.match(/^\s*(\d{1,2})(?::(\d{2}))?\s*$/);
  return match ? timeMatchToISO(match) : null;
}

function timeMatchToISO(match: RegExpMatchArray): string | null {
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const deadline = new Date();
  deadline.setHours(hour, minute, 0, 0);
  if (deadline.getTime() < Date.now()) {
    deadline.setDate(deadline.getDate() + 1); // already passed today -> assume tomorrow
  }
  return deadline.toISOString();
}

function clockTime(minutesFromNow: number | null): string {
  if (minutesFromNow === null) return "an unknown time";
  const t = new Date(Date.now() + minutesFromNow * 60000);
  return t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function narrate(option: TransportOption | undefined, confidence: number): string {
  if (!option) return "Couldn't match Jev's pick back to a specific option -- try again.";
  const pct = (confidence * 100).toFixed(0);

  if (option.mode === "bus") {
    return `Hop on the bus -- it's about ${option.etaMinutes} min out and ${option.reliability}. You'd arrive around ${clockTime(option.etaMinutes)} (${pct}% confidence this is your best bet).`;
  }
  if (option.mode === "ferry") {
    const terminal = cap((option.raw as any)?.terminal ?? "the terminal");
    return `Catch the ${terminal} ferry -- it leaves in ${option.etaMinutes} min, ${option.reliability}. Departure around ${clockTime(option.etaMinutes)} (${pct}% confidence).`;
  }
  if (option.mode === "bike/scooter") {
    return `Grab a bike or scooter -- ${option.reliability}, about a ${option.etaMinutes} min walk to reach one, so you'd be moving by around ${clockTime(option.etaMinutes)} (${pct}% confidence).`;
  }
  if (option.mode.startsWith("scooter->")) {
    const terminal = cap(option.mode.replace("scooter->", "").replace(" ferry", ""));
    return `Grab a scooter and head to the ${terminal} terminal -- ${option.reliability}. Ferry departs around ${clockTime(option.etaMinutes)} (${pct}% confidence).`;
  }
  return `Take the ${option.mode.replace(/_/g, " ")} -- ${option.reliability}, around ${clockTime(option.etaMinutes)} (${pct}% confidence).`;
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

  // Word-count thresholds are too rigid -- a real destination can be one or
  // two words ("Mill valley", "Sausalito"). Instead, exclude only a short
  // list of pure greetings/acknowledgements; treat everything else as a
  // potential goal statement.
  const GREETINGS = new Set([
    "hi", "hello", "hey", "yo", "sup", "ok", "okay", "k", "thanks", "thank you",
    "yes", "no", "cool", "nice", "great", "got it", "sounds good",
  ]);
  const looksLikeGoal = text.length > 0 && !GREETINGS.has(text.toLowerCase());
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

  // Real geocoding of the DESTINATION from what the user said -- no
  // hardcoded/demo location. Origin is fixed to the CodeRabbit office (see
  // above): finding "nearest stop/terminal" has to be relative to where the
  // user is actually boarding transit from, not the place they're headed to
  // -- that conflation was the earlier bug ("what location is this using?").
  const destination = await resolveLocation(goal);
  if (!destination) {
    await space.send(
      `Couldn't figure out a specific destination from that. Try naming a city or neighborhood (e.g. "Sausalito" or "Mill Valley").`
    );
    continue;
  }

  const deadlineISO = extractDeadlineISO(goal);
  await space.send(
    `From ${ORIGIN_LABEL} to ${destination.displayName}${deadlineISO ? ` by ${new Date(deadlineISO).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""} — checking your options...`
  );

  const nearestTerminal = findNearestTerminal(ORIGIN_LAT, ORIGIN_LNG);
  const nearestStop = await findNearestStop(ORIGIN_LAT, ORIGIN_LNG);

  const terminalCoords = nearestTerminal ? FERRY_TERMINALS[nearestTerminal.terminal] : null;

  const [bus, bike, ferry, combo] = await Promise.all([
    nearestStop ? getBusStatus(nearestStop.id) : Promise.resolve(null),
    getBikeScooterAvailability(ORIGIN_LAT, ORIGIN_LNG),
    nearestTerminal ? Promise.resolve(getFerrySchedule(nearestTerminal.terminal as any)) : Promise.resolve(null),
    nearestTerminal && terminalCoords
      ? getScooterToFerryCombo(
          ORIGIN_LAT,
          ORIGIN_LNG,
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
      `No viable live options from ${ORIGIN_LABEL} right now (${relevanceNotes.join(", ")}).`
    );
    continue;
  }

  const decision = await decide(options, {
    what: goal,
    whenISO: deadlineISO ?? "",
    where: destination.displayName,
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
