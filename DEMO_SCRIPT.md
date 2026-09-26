# Commute Copilot — Demo Script

Target: ~4 minutes. One screen (the dashboard) plus your phone as a live prop.

---

## 1. The Problem (30s)

> "Google Maps shows you routes. It doesn't decide for you — and it has real, specific blind spots. Ferry options get buried under bus/walk suggestions. It has zero concept of what you're actually trying to do next, like 'I need to be somewhere by 4pm.' And when a bus is running late, the static schedule Maps shows you doesn't know that.
>
> Commute Copilot is the decision layer on top of the same live data — it doesn't just show you options, it picks one, and tells you why."

---

## 2. Tech Stack (45s)

Say what each piece *enabled*, not just its name — judges are scoring architecture, not a tool list.

- **Jev's `Choice` primitive** — this is the core bet. Every decision here is a discrete choice among a small, known set of options (this bus vs. this ferry vs. a scooter), re-scored as conditions change. That's not a generation problem, it's a discriminative one — exactly Jev's shape. At $0.042/MTok input and 70–500ms latency, it's cheap and fast enough to re-run on *every single message* instead of caching one static answer. A general LLM call here would be slower, more expensive, and — critically — wouldn't give you a calibrated probability distribution over the actual options, just a paragraph.
- **511.org (SF Bay Open Data)** — real live bus GPS and delay data, plus live traffic incidents. Free, official, no scraping.
- **GBFS (Bay Wheels feed)** — live per-vehicle bike/scooter locations. Open standard, no auth.
- **Nominatim (OpenStreetMap)** — turns "Mill Valley" typed into iMessage into real coordinates, free, no key.
- **Browserbase + Stagehand** — the one deliberate scrape: there's no free API for "what does Google Maps itself recommend," so this is used as an honest comparison baseline, not a data source the app depends on.
- **Photon / Spectrum** — ships the whole thing over iMessage with no app to install. This is what makes "just text where you're headed" possible without building a messaging stack from scratch.
- **Next.js on Vercel** — the same decision engine, visualized live.

---

## 3. Live Demo + Code (2–2.5 min)

### a) Open the dashboard first — don't lead with a text message

Have the map up, ambient live counts visible (buses, Bay Wheels bikes, ferry terminals, traffic events). Say: *"This is all real, right now — you can hit these same public endpoints yourself."*

### b) Pull out your phone, text the live number

Send something with a real destination + deadline, e.g.:
> "I need to get to Mill Valley by 4pm"

While it's "checking," talk over the wait: *"No GPS sharing over iMessage, so the destination comes from what I typed — origin is a fixed known point for this demo."*

### c) Point at the dashboard, not the phone, for the payoff

Within ~5 seconds the request appears in **Recent Requests (live)** on the dashboard — this is the moment that proves it's one connected system, not two demos glued together. Say: *"Notice I didn't touch the dashboard — that came from the text message."*

### d) Click into the Decision Trace

This is the technical-execution payoff. Show:
- **Included options** with real numbers (ferry ETA from the actual schedule, live bike count) and Jev's probability split — call out that a close split (e.g. 58/42) comes with a genuinely lower confidence score, not a fake 100%.
- **Excluded options with real reasons** — e.g. *"bus excluded: 18.5km is beyond a single local Muni stop's realistic range."* This is the answer to "why not just take a bus" — the system actually reasons about whether an option can physically complete the trip, not just whether something's nearby.
- Click **"Show what Jev was actually asked"** — the literal state string and instructions sent to the API. Full transparency, nothing hidden in a black box.

### e) Show the Maps comparison panel

*"Here's what Google Maps itself recommends for the same trip, scraped live via Browserbase — side by side with Jev's pick."*

### f) Code walkthrough (30s, have these two files open)

- `src/data-sources.ts` — `findNearestTerminal` called twice: once from the origin (which terminal do I board at), once from the destination (which line actually gets me there). Say: *"This was a real bug I caught live during testing — using only 'nearest to origin' meant the ferry choice never actually depended on where you were going."*
- `src/jev.ts` — the `decide()` call: show how plainly the options become a Jev `Choice` request. Point at `criteria` and `instructions` — this is the entire "brain" of the app in about 15 lines.

---

## Closing line

> "Every number on this screen — bus delay, bike count, ferry time, Jev's confidence — is live and independently checkable. Nothing here is a demo fixture."

---

## If a judge pushes back

- **"Isn't this just an API aggregator?"** → The aggregation isn't the point — Jev's job is exactly the part a plain API list can't do: pick one, with a calibrated confidence, re-evaluated live per message.
- **"What's fake here?"** → Be direct: origin is a fixed point (no GPS via iMessage), dashboard route lines are straight-line legs not turn-by-turn, ferry ETA is a same-day schedule approximation. Everything else — every number shown — is a live call to a real public endpoint.
- **"Does this scale beyond SF?"** → The architecture (live feed → geocode → Jev choice) isn't SF-specific — only the data sources wired up today are. Next city just needs its own transit API adapter.
