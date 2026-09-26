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
  haversineKm,
  WALK_SPEED_KMH,
} from "./data-sources.js";
import { decide } from "./jev.js";

type TransportOption = {
  mode: string;
  etaMinutes: number | null;
  reliability: string;
  raw: unknown;
  label?: string;
};

/** Turn the winning option into a natural, friend-texting-you sentence
 * instead of a raw mode label -- uses the real computed numbers already
 * on the option (eta, reliability text), not a template restating the
 * mode name. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Terminal keys are lowercase lookup strings ("sf ferry building"); cap()
// alone only capitalizes the first letter, which reads oddly for a
// multi-word name -- use the proper display name for ones we know.
const TERMINAL_LABEL: Record<string, string> = {
  "sf ferry building": "SF Ferry Building",
  sausalito: "Sausalito",
  larkspur: "Larkspur",
  tiburon: "Tiburon",
};
function terminalLabel(terminal: string): string {
  return TERMINAL_LABEL[terminal] ?? cap(terminal);
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
  const match = text.match(/\b(?:by|around|at|before|near|about)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
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
    return `Take the ${option.label ?? "bus"} -- it's about ${option.etaMinutes} min out and ${option.reliability}. You'd arrive around ${clockTime(option.etaMinutes)} (${pct}% confidence this is your best bet).`;
  }
  if (option.mode === "ferry") {
    return `${option.label ?? "Catch the ferry"} -- it leaves in ${option.etaMinutes} min, ${option.reliability}. Departure around ${clockTime(option.etaMinutes)} (${pct}% confidence).`;
  }
  if (option.mode === "bike/scooter") {
    return `Grab a ${option.label ?? "bike or scooter"} -- ${option.reliability}, about a ${option.etaMinutes} min walk to reach one, so you'd be moving by around ${clockTime(option.etaMinutes)} (${pct}% confidence).`;
  }
  if (option.mode.startsWith("scooter->")) {
    return `${option.label ?? "Grab a scooter and head to the ferry terminal"} -- ${option.reliability}. Ferry departs around ${clockTime(option.etaMinutes)} (${pct}% confidence).`;
  }
  return `Take the ${option.mode.replace(/_/g, " ")} -- ${option.reliability}, around ${clockTime(option.etaMinutes)} (${pct}% confidence).`;
}

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "https://jevathon-commute-assistant.vercel.app";
const TRIP_LOG_SECRET = process.env.TRIP_LOG_SECRET;

/** Publish each decision to the dashboard so a trip requested over iMessage
 * shows up there too -- the two surfaces used to be completely disconnected
 * (the dashboard had no idea iMessage traffic existed at all). Best-effort:
 * never let a slow/failed network call delay or break the iMessage reply. */
async function logTripToDashboard(payload: unknown): Promise<void> {
  if (!TRIP_LOG_SECRET) return;
  try {
    await fetch(`${DASHBOARD_URL}/api/trip-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: TRIP_LOG_SECRET, ...(payload as object) }),
    });
  } catch {
    // dashboard being down is not the user's problem
  }
}

/** Real walking time from Google Maps (via the dashboard's Browserbase-backed
 * /api/walk-time), not a straight-line distance / assumed speed -- a
 * haversine estimate can say "4 min away" for a walk that's actually 7 min
 * once real streets are accounted for, which is exactly what made a ferry
 * look catchable when it wasn't. Falls back to the haversine estimate if the
 * dashboard call is slow or fails -- a live decision shouldn't hang on a
 * browser automation call. */
async function getWalkMinutes(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<number> {
  try {
    const controller = new AbortController();
    // Give the dashboard's own internal timeout (20s) room to actually fire
    // and fall back to its own estimate before we cut the request off here.
    const timeout = setTimeout(() => controller.abort(), 25000);
    const res = await fetch(
      `${DASHBOARD_URL}/api/walk-time?fromLat=${fromLat}&fromLng=${fromLng}&toLat=${toLat}&toLng=${toLng}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) throw new Error("walk-time request failed");
    const data = (await res.json()) as { walkMinutes: number };
    return data.walkMinutes;
  } catch {
    const km = haversineKm(fromLat, fromLng, toLat, toLng);
    return (km / WALK_SPEED_KMH) * 60;
  }
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
    // Clear the failed goal so the NEXT message (even something short like
    // "Hi") is treated as a fresh attempt instead of silently retrying the
    // same unresolvable text forever -- found live during demo testing.
    trackedGoals.delete(space.id);
    await space.send(
      `Couldn't figure out a specific destination from that. Try naming a city or neighborhood (e.g. "Sausalito" or "Mill Valley").`
    );
    continue;
  }

  const deadlineISO = extractDeadlineISO(goal);
  await space.send(
    `From ${ORIGIN_LABEL} to ${destination.displayName}${deadlineISO ? ` by ${new Date(deadlineISO).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""} — checking your options...`
  );

  // The terminal that matters for BOARDING is nearest to the origin; the
  // terminal that matters for the actual ferry LINE is the one nearest the
  // DESTINATION (all Golden Gate Ferry boats leave from the SF side -- which
  // one you take depends on where you're going, not where you're standing).
  // Using only "nearest to origin" for both was the earlier bug: it always
  // picked the same terminal regardless of destination, so the ferry choice
  // had nothing to do with where the user was actually headed.
  const boardingTerminal = findNearestTerminal(ORIGIN_LAT, ORIGIN_LNG);
  const arrivalTerminal = findNearestTerminal(destination.lat, destination.lng);
  const nearestStop = await findNearestStop(ORIGIN_LAT, ORIGIN_LNG);

  const destDistanceKm = haversineKm(ORIGIN_LAT, ORIGIN_LNG, destination.lat, destination.lng);
  // A scooter/bike or a single local Muni stop can't realistically cover a
  // cross-bay trip -- offering them as "100% confidence" options for a
  // destination like Mill Valley (12+ km, across the Golden Gate) was the
  // second bug: distance from the origin to the nearest stop/vehicle was
  // being checked, but never distance to the actual destination.
  const SCOOTER_MAX_KM = 5;
  const BUS_MAX_KM = 15;
  const scooterPlausible = destDistanceKm <= SCOOTER_MAX_KM;
  const busPlausible = destDistanceKm <= BUS_MAX_KM;

  const ferryRelevant =
    !!boardingTerminal && !!arrivalTerminal && boardingTerminal.terminal !== arrivalTerminal.terminal;
  const boardingCoords = boardingTerminal ? FERRY_TERMINALS[boardingTerminal.terminal] : null;

  // A fixed schedule is only actually catchable if there's enough real time
  // left to walk to the terminal -- checked live via Google Maps (see
  // getWalkMinutes), not assumed. Only fetched when a ferry is even in play.
  const walkToBoardingMin =
    ferryRelevant && boardingCoords
      ? await getWalkMinutes(ORIGIN_LAT, ORIGIN_LNG, boardingCoords.lat, boardingCoords.lng)
      : 0;

  const [bus, bike, ferry, combo] = await Promise.all([
    nearestStop && busPlausible ? getBusStatus(nearestStop.id, nearestStop.name) : Promise.resolve(null),
    scooterPlausible ? getBikeScooterAvailability(ORIGIN_LAT, ORIGIN_LNG) : Promise.resolve(null),
    ferryRelevant
      ? Promise.resolve(getFerrySchedule(arrivalTerminal!.terminal as any, walkToBoardingMin))
      : Promise.resolve(null),
    ferryRelevant && boardingCoords
      ? getScooterToFerryCombo(
          ORIGIN_LAT,
          ORIGIN_LNG,
          arrivalTerminal!.terminal as any,
          boardingCoords.lat,
          boardingCoords.lng
        )
      : Promise.resolve(null),
  ]);

  // Ferry/combo labels only know the arrival terminal on their own -- fill
  // in the boarding side here, where both are actually known, so the reply
  // says exactly where to get on, not just where the boat is headed.
  if (ferry) ferry.label = `Ferry to ${terminalLabel(arrivalTerminal!.terminal)} (board at ${terminalLabel(boardingTerminal!.terminal)})`;
  if (combo) combo.label = `${combo.label?.split(" to the ")[0]} to ${terminalLabel(boardingTerminal!.terminal)}, then the ferry to ${terminalLabel(arrivalTerminal!.terminal)}`;

  const options = [bus, ferry, bike, combo].filter(
    (o): o is NonNullable<typeof o> => o !== null && o.etaMinutes !== null
  );

  // Be transparent about what was and wasn't considered relevant, and why --
  // this is the full decision trace: what was checked, what was excluded and
  // why, not just the winning answer.
  const relevanceNotes: string[] = [];
  relevanceNotes.push(`destination is ${destDistanceKm.toFixed(1)}km from ${ORIGIN_LABEL}`);
  if (!busPlausible) relevanceNotes.push(`bus excluded: ${destDistanceKm.toFixed(1)}km is beyond a single local Muni stop's realistic range`);
  else if (nearestStop) relevanceNotes.push(`nearest bus stop: ${nearestStop.name} (${nearestStop.distanceKm.toFixed(1)}km from origin)`);
  else relevanceNotes.push("no SF Muni stop close enough to origin to be relevant");
  if (!scooterPlausible) relevanceNotes.push(`bike/scooter excluded: ${destDistanceKm.toFixed(1)}km is beyond a realistic scooter range (${SCOOTER_MAX_KM}km)`);
  if (!ferryRelevant) {
    relevanceNotes.push(
      !boardingTerminal || !arrivalTerminal
        ? "no ferry terminal close enough to either end of the trip to be relevant"
        : "ferry excluded: boarding and arrival terminal are the same (destination isn't across the bay)"
    );
  } else {
    relevanceNotes.push(
      `ferry: board at ${terminalLabel(boardingTerminal!.terminal)} (${boardingTerminal!.distanceKm.toFixed(1)}km from origin), line to ${terminalLabel(arrivalTerminal!.terminal)} (${arrivalTerminal!.distanceKm.toFixed(1)}km from destination)`
    );
  }

  if (options.length === 0) {
    await space.send(
      `No viable live options from ${ORIGIN_LABEL} to ${destination.displayName} right now.\n\n${relevanceNotes.map((n) => `• ${n}`).join("\n")}`
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
  const probsBlock = Object.entries(decision.probabilities)
    .map(([k, v]) => `• ${k.replace(/_/g, " ")}: ${(v * 100).toFixed(0)}%`)
    .join("\n");
  const notesBlock = relevanceNotes.map((n) => `• ${n}`).join("\n");

  await space.send(
    `${narrate(winner, decision.confidence)}\n\nWhy:\n${probsBlock}\n\nConsidered:\n${notesBlock}`
  );

  void logTripToDashboard({
    source: "imessage",
    origin: { lat: ORIGIN_LAT, lng: ORIGIN_LNG, label: ORIGIN_LABEL },
    destination: { lat: destination.lat, lng: destination.lng, label: destination.displayName },
    goal,
    deadlineISO,
    options,
    decision,
    relevanceNotes,
  });
}
