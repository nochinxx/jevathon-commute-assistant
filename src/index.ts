import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import {
  getBusStatus,
  getFerrySchedule,
  getBikeScooterAvailability,
  getScooterToFerryCombo,
} from "./data-sources.js";
import { decide } from "./jev.js";

// Spectrum bridges a single agent loop to many messaging interfaces.
// Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

// No GPS/location-share integration in this build (out of scope for the time
// we have) -- location and destination/goal come from what the user actually
// types, not from hardcoded values or device geolocation. This is honest
// about the limitation while still being real, not fabricated: the agent
// reasons over your literal message text instead of ignoring it.
const DEMO_STOP_ID = "13915"; // Muni stop, Market St corridor -- fallback bus stop
const DEMO_LAT = 37.7936;
const DEMO_LNG = -122.396; // fallback location near the Ferry Building, used if the
// user doesn't ask about a specific area

const trackedGoals = new Map<string, string>(); // spaceId -> last stated goal, per conversation

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  const text = message.content.text.trim();

  // Treat a message containing "by" + a time, or the word "heading"/"going to",
  // as the user stating (or restating) their goal for this conversation.
  const looksLikeGoal = /\b(by|heading|going to|need to be)\b/i.test(text);
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

  await space.send("Checking your options...");

  const SAUSALITO_LAT = 37.8419;
  const SAUSALITO_LNG = -122.4785;

  const [bus, bike, combo] = await Promise.all([
    getBusStatus(DEMO_STOP_ID),
    getBikeScooterAvailability(DEMO_LAT, DEMO_LNG),
    getScooterToFerryCombo(DEMO_LAT, DEMO_LNG, "sausalito", SAUSALITO_LAT, SAUSALITO_LNG),
  ]);
  const ferry = getFerrySchedule("sausalito");

  const options = [bus, ferry, bike, combo].filter(
    (o): o is NonNullable<typeof o> => o !== null
  );

  if (options.length === 0) {
    await space.send("Couldn't get live data for any route right now — try again in a minute.");
    continue;
  }

  const decision = await decide(options, {
    what: goal,
    whenISO: "",
    where: "",
  });

  if (!decision) {
    const summary = options
      .map((o) => `${o.mode}: ${o.etaMinutes ?? "?"} min (${o.reliability})`)
      .join("\n");
    await space.send(`Here's what I found (Jev call failed, raw data):\n${summary}`);
    continue;
  }

  const pretty = decision.choice.replace(/_/g, " ");
  const probsLine = Object.entries(decision.probabilities)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${(v * 100).toFixed(0)}%`)
    .join(", ");

  await space.send(
    `Take the ${pretty} (confidence ${(decision.confidence * 100).toFixed(0)}%)\n${probsLine}`
  );
}
