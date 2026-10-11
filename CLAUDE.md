# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

An iMessage road-trip agent for HackNC 2026 (Devpost due 10:00 AM ET, Oct 11 2026). It acts as an automated "group leader":
- Each traveler texts the agent in their own DM.
- The agent collects everyone's requirements and runs votes only where people differ.
- It drafts an itinerary with Gemini and web search, then iterates on it from natural-language feedback.
- When everyone approves, it sends a Photon mini-app dashboard with a map, a schedule and sustainability bars.

`dev/mvp` was started fresh from `main`. The earlier `dev/initial-scratch` branch (the Photon capability probe and spec-era scaffold) is **reference only** and is never merged.

**Status:** building the MVP. This file is completed at the end of the build.

## Deviations from the owner's pitch / data flow / user flow

| # | Pitch said | MVP does | Why |
|---|---|---|---|
| 1 | Voting through a poll widget | Polls are numbered text replies in each DM ("reply 1/2/3 or tell me what you'd prefer"), plus a poll-widget card at `/poll/:token` | On Photon **Pro**, native iMessage poll votes never reach the agent (proved by the probe on `dev/initial-scratch`). Card pages carry no identity, so each member's widget link holds a random per-(poll, member) token sent only in their own DM. |
| 2 | Google Maps or OpenStreetMap, whichever is free | OpenStreetMap: Leaflet tiles, Nominatim geocoding, OSRM routing. Google Maps appears only as a plain `maps/search` link. | OSM needs no billing account or key. Google Maps Platform requires billing. |
| 3 | No backend API if the frontend reads the DB directly | One read-only `GET /api/trips/:publicId` (plus the poll-widget GET/POST) on the agent's own Hono server | Reading Postgres from the browser would expose the Tiger Data credentials. The Node process has to run anyway to keep the Spectrum stream open. |
| 4 | Dashboard hosted on any free service | Served by the same Node process and exposed with `ngrok http 8787` (`PUBLIC_BASE_URL`) | Free hosts sleep and would cut the long-lived Spectrum stream. |
| 5 | Streamlit or AI-generated HTML/CSS/JS | Plain HTML/CSS/JS in `web/`, with Leaflet from cdnjs | The card opens at about 280×300 inside Messages, so a light static page fits. Streamlit would need a Python server and websockets. |
| 6 | Vote on any predefined requirement that differs | **Budget** automatically becomes the lowest stated (so everyone can afford it). **Dietary restrictions** are combined (union). Neither is voted on. | These are hard constraints, not preferences, so voting could exclude someone. This counts as "automatically resolving minor conflicts". |
| 7 | One vote per differing requirement | Start, end and round-trip/one-way are bundled into one **route** poll, and the two dates into one **dates** poll. Every poll has an "Either works" (abstain) option. A tie gets one revote between the tied options, and a predefined poll that is still tied aborts the trip. | Bundling keeps polling to a minimum. Without "Either works" and a revote, two-person trips would almost always deadlock. |
| 8 | (unspecified) | One active trip per phone number | Every message from a number has to map to exactly one trip. |
| 9 | (unspecified) | Trip times are in `TRIP_TIMEZONE` (default `America/New_York`) | We don't collect a time zone, and the demo corridor is in North Carolina. |
| 10 | Changes are auto, proposed or voted depending on impact | During **execution** (on the road), changes apply immediately and everyone is notified. The three tiers apply during itinerary review. | Last-minute changes on the road can't wait for re-approval. |
| 11 | Gas savings and carbon footprint | Computed in code from OSRM distance and `VEHICLE_MPG`/`GAS_PRICE_USD_PER_GALLON`, at 8.887 kg CO₂ per gallon (EPA). Carpooling savings are measured against each member driving solo. The dashboard labels all of these as assumptions. | Gemini never supplies distances, times, fuel or CO₂. |
| 12 | (unspecified) | Each member's first name is captured when they join | Polls, status messages and the dashboard show first names, never phone numbers. |
| 13 | (unspecified) | Text messages only. Voice, images and attachments get a "text only for now" reply. | Keeps the MVP small. Voice notes would need to be transcoded first. |
| 14 | (unspecified) | Planning starts once at least `MIN_MEMBERS` (default 2) people have joined | Stops a host's early `ready` from launching a solo trip. Set it to 1 for solo testing. |
