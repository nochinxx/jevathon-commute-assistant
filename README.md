# Commute Copilot

**A live, text-message commute decision assistant for San Francisco — built for JEVATHON.**

Text it where you're headed. It pulls real live transit data from multiple independent public sources, and Jev picks the option that actually gets you there most reliably — with a calibrated confidence score, not just a list of times.

## The problem

Google Maps optimizes information — it shows you routes and ETAs and leaves the judgment call to you. It also has real, specific gaps: ferry options are inconsistently surfaced, and it has no concept of what you're actually trying to do next. Meanwhile, real commuters (the author included) routinely get left behind by buses whose live conditions diverge from the static schedule.

Commute Copilot is the decision layer on top of the data Maps already has: given real-time bus positions, a fixed ferry schedule, live bike/scooter availability, and what you actually told it, Jev picks — and explains its confidence — instead of handing you a list.

## Live

- **Dashboard:** https://jevathon-commute-assistant.vercel.app
- **iMessage:** ask in Discord / at the table for the live demo number

## Architecture

| Layer | Source | Why this one |
|---|---|---|
| Bus/Muni (live) | [511.org Vehicle/Stop Monitoring API](https://511.org/open-data) | Real GPS + live delay data, free, official — no scraping needed |
| Ferry | Golden Gate Ferry fixed schedule | Ferries run a locked schedule; the gap is that Maps under-surfaces this, not that the data is hard to get |
| Bike/scooter (live) | [GBFS](https://gbfs.org) `free_bike_status` feed (Bay Wheels) | Open, standardized, no-auth format used by most bike-share systems |
| Traffic incidents (live) | 511.org Traffic Events API | Real active incidents with coordinates, same token as transit |
| Destination geocoding | OpenStreetMap Nominatim | Free, no key, turns "Mill Valley" into real coordinates |
| Google Maps (comparison + walk time) | Browserbase + Stagehand | The one thing with no free API. Used two ways: as an honest side-by-side comparison against Jev's pick, and to get a *real* walking time to a ferry terminal (a straight-line distance estimate can say "4 min away" for a walk that's actually 7) — cached per route since walking pace doesn't change with traffic, with a distance-based estimate as a fallback if the scrape is slow or fails |
| Decision engine | [Jev](https://typesafe.ai) `Choice` primitive | Given the live options + your stated goal, picks (and ranks) the best one with a real probability distribution |
| Interface | [Photon / Spectrum](https://photon.codes) | One agent, delivered over iMessage — no app to open |
| Dashboard | Next.js on Vercel | Same data + decision logic, visualized: live map, colored route options, Jev's pick highlighted in green, a full decision trace (every option considered, live data behind it, exclusions with real reasons, the literal request sent to Jev), a live feed of recent requests from either surface, and live vs. Maps side by side |

**Why Jev specifically, not a general LLM:** every decision here is a *discrete choice among a small, known set of options* (this bus vs. this ferry vs. a scooter), re-evaluated as conditions change — not a search/optimization problem. That's Jev's exact shape, and its cost profile ($0.042/MTok input, output free, 70–500ms) is what makes it viable to re-run this on every message instead of caching a single answer.

## What's real vs. what's simplified

- **Real:** every data source above is live and independently verifiable — open the same public URLs yourself and the numbers will match what the app just used. Options aren't just filtered by "is something nearby" — a scooter or a single local Muni stop is excluded outright once the destination requires crossing the bay or is beyond a realistic range, with the reason stated, not just quietly left off.
- **Origin is fixed** to the CodeRabbit office (201 Spear St) for this demo — there's no GPS/location-sharing available through iMessage, so the destination comes from what you type and the origin is a known fixed point rather than fabricated.
- **Route paths on the dashboard are straight-line legs**, not turn-by-turn routing — there's no free turn-by-turn API in scope for a 3-hour build.
- **Ferry ETA on the dashboard's trip planner uses the fixed schedule as a same-day approximation**, not a live feed (ferries don't have one — they're not late).

## Running it locally

```sh
pnpm install
pnpm start          # the iMessage agent (src/index.ts)
cd dashboard && pnpm dev   # the web dashboard
```

Needs a `.env` (agent, see `.env.example`) with `PROJECT_ID`/`PROJECT_SECRET` (Photon), `FIVE_ELEVEN_TOKEN`, `TYPESAFE_API_KEY`, `DASHBOARD_URL`, and `TRIP_LOG_SECRET`. The dashboard needs its own `.env.local` with `FIVE_ELEVEN_TOKEN`, `TYPESAFE_API_KEY`, `BROWSERBASE_API_KEY`, and the same `TRIP_LOG_SECRET` (it's what authenticates the agent's requests to `/api/trip-log`).

## What's next

- Real origin detection (would need a proper app with device location, not just text)
- Calendar/Luma integration so the deadline comes from your actual schedule, not something you type each time
- Expand beyond SF: the architecture (live feed → geocode → Jev choice) is not SF-specific, just the specific data sources wired up today are

## License

MIT
