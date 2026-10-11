## Inspiration
Planning a road trip with friends means:
- agreeing on the destination, dates and activities,
- ironing out the details (budgets, dietary needs, where to stop),
- and making sure everyone actually replies!

But there's a hidden task: one person has to become the **"group leader"** who organizes everything *and* everyone.

We've been that person many times, so we built **Trippy** to automate that job. It makes group planning more democratic (everyone gets a say) and much faster.

## What it does
Trippy is an AI group leader that lives in iMessage. Each traveler texts Trippy in their own DM. Trippy collects everyone's requirements, finds where the group disagrees, puts only those disagreements to a vote, and plans the itinerary.

1. **Start and join in one text.** `new trip` starts a trip and sends a standalone `join CODE` message the host forwards to friends. Trippy reads each person's first name from their Photon user record, so nobody gets asked.
2. **Three quick questions:**
   - 📍 Where? The host sets the starting point, and friends just pick a destination.
   - 📅 When? e.g. "Oct 18–19".
   - 💵🥗 Budget and dietary needs? e.g. "$300, halal".

   Replies like `Octobr 18 to 19` or `250, none` are understood instantly. Gemini handles anything written as a full sentence.
3. **"Anything else?"** One reply adds a wish ("beach day", "seafood") or says "nope".
4. **Settles what it can on its own:**
   - the budget becomes the lowest one stated, so everyone can afford the trip;
   - everyone's dietary needs are combined;
   - "Wilmington" and "Wilmington, NC" count as the same place;
   - wishes are checked to make sure they fit together.
5. **Polls only where people differ.** The destination and dates go to a vote. Reply with a number or in your own words ("Asheville!"). A tie gets a revote.
6. **Plans while you vote.** As soon as a poll opens, Trippy researches an itinerary for every possible outcome with Gemini and live Google Search, so the plan is ready seconds after the last vote.
7. **The itinerary is a mini-app.** "✅ Itinerary ready!" is followed by a Photon mini-app card that opens a trip dashboard inside iMessage, with Map, Schedule, Impact and Trip tabs.
8. **A send-off.** Everyone gets a line that fits the destination ("🏖️ You're set for Wilmington! … don't forget to pack sunscreen 🧴😎") and a dap GIF.
9. **Live re-planning on the road:**
   - "we're 30 min late" shifts the rest of the day;
   - "sushi instead of pizza" swaps a stop.

   Everyone is notified, and every card updates in place.
10. **Optional review round**, behind a setting. Each piece of feedback is classified and handled one of three ways:
    - **minor:** applied automatically;
    - **material:** everyone approves again;
    - **conflicting:** goes to a vote.

## How we built it
- **Photon Spectrum (`spectrum-ts`):** iMessage DMs, mini-app cards that are edited in place, typing indicators and GIF attachments, plus Photon's users API for first names.
- **Gemini 3.8 Flash (Interactions API):** structured output with Google Search grounding to research itineraries, plus reading free-form answers and live updates. Each task runs at its own thinking level.
- **OpenAI Decisions API (`gpt-6-luna`):** fast choices from a fixed set of options, in about 150–300 ms. It maps free-text votes to poll options, sorts wishes, checks that wishes fit together and picks the destination's vibe. Gemini is the fallback for each.
- **Tiger Data (Postgres + TimescaleDB) with Drizzle ORM:** stores trips, members, requirements, polls and every itinerary version, plus `chat_events` and `trip_events` hypertables.
- **OpenStreetMap:** Leaflet tiles, Komoot Photon and Nominatim for geocoding, OSRM for routing.
- **TypeScript on Node 24** with a Hono HTTP server. **Zod** schemas check every contract and every LLM response.
- **Plain HTML/CSS/JS** for the dashboard, in a Frutiger Aero style.
- **Vitest + PGlite:** 89 tests that run fully offline against the real database migrations.

Our design rule: Gemini decides *what* to do, and code computes every number. Distances, drive times, fuel, CO₂ and the schedule all come from OSRM and our own code, never from the model.

## Challenges we ran into
- **Photon Pro doesn't deliver group-chat messages to the agent,** so Trippy can't sit in a group chat. Instead each traveler DMs Trippy, and Trippy coordinates the group across those DMs, starting with a forwardable join message.
- **Native iMessage polls can be sent, but the votes never reach the agent.** We switched to numbered replies plus free-text votes ("Asheville sounds better"), which OpenAI Decisions maps to the right option. We also built a poll mini-app; it's turned off so people vote by texting.
- **Gemini latency.** Researching an itinerary with web search took **74–86 seconds** at Gemini's default thinking level. What brought it down:
  - a lower thinking level (about 11 s);
  - a cap of 3 web searches (7–10 s);
  - fewer stops;
  - researching every possible vote outcome while people vote.

  In our rehearsal, the itinerary arrived about 12 seconds after the final vote.
- **Too many back-and-forth messages.** Our first version needed about 12 messages per person. We cut it to about 6, most answered instantly, by:
  - grouping the questions;
  - reading answers with code first, which also catches misspelled months;
  - taking names from Photon;
  - letting the host set the starting point.
- **Limits of Gemini's structured output.** It rejects `oneOf`, and `minItems`/`maxItems` on nested arrays return HTTP 400. We kept the schemas flat and enforce those rules with Zod after parsing.
- **Mini-app quirks:**
  - live cards render at text-bubble size, which was too cramped, so we send regular cards that open near-full-screen;
  - every card edit returns a new handle that we have to store for the next edit;
  - the in-app browser won't open new windows;
  - free ngrok puts a warning page in front of the dashboard;
  - the hackathon network blocked Cloudflare's quick tunnels.
- **Finding real businesses on a map.** OpenStreetMap geocoders happily return a same-name place in another city. A result only counts if its name and city match (or it's within 30 km). Otherwise the stop is marked "approx." or dropped, and dropped stops are listed on the dashboard.

## Accomplishments that we're proud of
- A **multi-user group-leader agent on iMessage** that coordinates a whole group across separate DMs, from `new trip` to a shared dashboard.
- The **Photon mini-app trip dashboard**, designed by Pranav in Frutiger Aero!
  - **Map:** an interactive map of the route and stops.
  - **Schedule:** an interactive schedule; tap a stop to jump to it on the map.
  - **Impact:** sustainability metrics, including gas and money saved by carpooling, CO₂ per person compared with driving alone, and green stops.
  - **Trip:** a traceability page showing the crew, every group decision with its vote count, and the itinerary version.
- **Tiger Data for time-based tracking.** Every message in and out is logged to a `chat_events` hypertable, which also filters out the duplicate deliveries Photon can send. Trip milestones (`trip_created`, `member_joined`, `phase_changed`, `poll_closed`, `live_update`) go to `trip_events`.
- **Speed.** Answers to the planning questions get instant replies, OpenAI Decisions responds in 150–300 ms, and the itinerary is researched while people vote.
- **Honest numbers.** Every distance, time, fuel and CO₂ figure is calculated by code, and Gemini's price estimates are labeled as estimates.
- **Privacy by design.** Dashboards show only first names and group totals: no phone numbers, no individual requirements, and polls never show who suggested what.

## What we learned
- Our first idea and prototype needed a **hard pivot** once we found out that Photon Pro doesn't deliver group-chat messages.
- Claude Code alone couldn't search the Photon docs and build a working MVP to test our idea.
- So we refined the idea **without AI**, spending more than 2 hours on a design document covering the project idea, user flow and data flow. Pranav also designed the dashboard instead of asking Claude to come up with one from scratch.
- Giving Claude Code that design document produced a much better MVP, which only needed polish to improve the user experience.
- Measure before optimizing. Gemini's thinking level, not our prompt, was the biggest factor in its latency. And wherever plain code could read an answer, it beat an LLM call.

## What's next for Trippy
- **Group chat integration**, once Photon supports group-chat messages.
- **Multimodal input:** photos, audio, video and text.
- **More dashboard styles** beyond Frutiger Aero.
- **One-way trips and a separate starting point for each person.** The planner already supports both; they're turned off for the demo.
