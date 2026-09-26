import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { getBusStatus, getFerrySchedule, getBikeScooterAvailability } from "./data-sources.js";
import { decide } from "./jev.js";

// Spectrum bridges a single agent loop to many messaging interfaces.
// Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

// Hardcoded for the demo: a known SF Muni stop + user's current-ish location.
// (Real version would geolocate / let the user configure this.)
const DEMO_STOP_ID = "13915"; // Muni stop, Market St corridor
const DEMO_LAT = 37.7936;
const DEMO_LNG = -122.3960; // near the Ferry Building / Embarcadero

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;

  await space.send("Checking your options...");

  const [bus, bike] = await Promise.all([
    getBusStatus(DEMO_STOP_ID),
    getBikeScooterAvailability(DEMO_LAT, DEMO_LNG),
  ]);
  const ferry = getFerrySchedule("sausalito");

  const options = [bus, ferry, bike].filter((o): o is NonNullable<typeof o> => o !== null);

  if (options.length === 0) {
    await space.send("Couldn't get live data for any route right now — try again in a minute.");
    continue;
  }

  const decision = await decide(options);

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
