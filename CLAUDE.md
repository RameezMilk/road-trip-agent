# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

An iMessage road-trip agent for HackNC 2026 (Devpost due 10:00 AM ET, Oct 11 2026). It acts as an automated "group leader":
- Each traveler texts the agent in their own DM.
- The agent collects everyone's requirements and runs votes only where people differ.
- It drafts an itinerary with Gemini and web search, then iterates on it from natural-language feedback.
- When everyone approves, it sends a Photon mini-app dashboard with a map, a schedule and sustainability bars.
- On the road, it re-plans live from messages like "we're 30 min late" or "sushi instead of pizza".

`dev/mvp` was started fresh from `main`. The earlier `dev/initial-scratch` branch (the Photon capability probe and spec-era scaffold) is **reference only** and is never merged. Its probe findings are summarized under "Rules" below.

**Status:** MVP built and tested offline (fakes plus PGlite). Live use needs `GEMINI_API_KEY` and a Tiger Data `DATABASE_URL` in `.env`.

## Commands

```sh
npm install
npm run dev            # agent + HTTP on :8787 (tsx watch). Needs DATABASE_URL; runs migrations on boot
npm start              # same, without watch
npm run dev:demo       # dashboard + poll widget for a seeded, visibly labeled DEMO DATA trip (in-memory PGlite, no keys)
npm run db:migrate     # apply drizzle/* to Tiger Data (boot also does this)
npm run db:generate    # regenerate SQL after editing src/db/schema.ts (offline)
npm run db:tail -- --limit 50   # latest chat_events rows (handles shown as last 4 digits)
npm run llm:smoke      # one structured + one Google-Search-grounded Gemini call (checks key + model)
npm run typecheck && npm run lint && npm test
npx vitest run src/agent/engine.test.ts -t "aborts"   # single test
```

Cards need public HTTPS. Run `ngrok http 8787` and put the URL in `PUBLIC_BASE_URL`. Scripts load `.env` via `tsx --env-file-if-exists=.env`.

## Architecture

Single package: ESM TypeScript on Node 24, with TypeScript pinned to 6.x because spectrum-ts's peer range excludes 7. **One long-lived process** holds:
- the Spectrum gRPC stream,
- the Hono HTTP server,
- the static `web/` pages.

Never move it to serverless or edge, because the stream must stay connected.

- **`src/schemas/`** holds every contract as a Zod 4 `z.strictObject`:
  - Unknown keys are rejected, timestamps carry an offset, units are in field names, and IDs are prefixed (`trip_`, `mem_`, `req_`, `poll_`, `opt_`, `stop_`, `evt_`).
  - Commands are a Zod enum plus a discriminated union (`chat-command.ts`). Never compare raw strings like `"ready"`.
  - `llm.ts` holds the **flat** schemas Gemini fills. Gemini's JSON-schema subset rejects `oneOf`, so there are no discriminated unions, regexes or refinements, and a test enforces this.
- **`src/agent/`**:
  - `engine.ts` dispatches each DM by trip phase to `phases/*`.
  - All state is in the DB, and handlers re-read what they need.
  - `KeyedQueue` serializes work per trip. `runtime.ts` additionally serializes per sender.
  - Phase changes are compare-and-set (`repo.transition(from, to)`).
  - Drafting runs **outside** the queue (`Engine.startDraftJob`), then commits back through it. On boot, `resumeDrafting()` restarts trips stuck in `drafting`.
  - Every user-facing string is in `copy.ts`.
- **`src/domain/`** holds pure, unit-tested logic:
  - `reconcile` compares requirements and builds polls.
  - `tally` picks the winner and handles revotes and tiebreaks.
  - `schedule` computes times, `shiftSchedule` and `rescheduleFrom`.
  - `sustainability`, `diff`, and `time` (time-zone math with no library).
- **`src/services/`**:
  - `Llm` port, implemented by `GeminiLlm`. It uses the Interactions API with `store:false` and a JSON `response_format`, plus the Google Search tool when `webSearch`. Results are Zod-validated with one repair retry, and the grounded-text-then-structured fallback is used if the combination fails.
  - `NominatimGeocoder`: 1 req/s, identifying User-Agent, cached.
  - `OsrmRouter`: one multi-waypoint call, with a haversine fallback labeled `estimate`.
  - `Planner`: Gemini picks places, OSM locates them, and code computes every number.
- **`src/chat/`**:
  - `ChatPort` is the provider-neutral boundary.
  - `spectrum.ts` is the **only** importer of `spectrum-ts`. It maps the stream, sends text and cards, edits cards in place, and records every outbound message to `chat_events`.
  - `commands.ts` parses text into `ChatCommand`.
- **`src/db/`**:
  - Drizzle over postgres-js against Tiger Data, the only operational store.
  - Tables: `trips`, `members`, `predefined_requirements` (one row per member, real columns), `optional_requirements`, `polls`, `poll_votes`, `poll_tokens`, `itinerary_versions` (jsonb `Itinerary`), and `approvals`.
  - `chat_events` and `trip_events` are TimescaleDB hypertables. The migration `drizzle/0001_hypertables.sql` is a no-op without TimescaleDB.
  - `repo.ts` re-parses jsonb through Zod on read. Tests use `createMemoryDb()` (PGlite, real migrations).
- **`src/http/app.ts`** routes:
  - `GET /api/trips/:publicId` returns `TripDashboard`.
  - `/trip/:publicId` serves the dashboard page with OG tags.
  - `/poll/:token` and `GET/POST /api/polls/:token` serve the poll widget.
  - `/web/*` serves static files.
- **`web/`** is plain HTML/CSS/JS in Frutiger Aero style, with Leaflet 1.9.4 from cdnjs and OSM tiles:
  - The dashboard has four touch-sized **tabs**: 🗺️ Map · 📋 Schedule · 🌱 Impact · 👥 Trip. Each fills the screen. Tapping a stop switches to Map and opens that stop's popup. The Map tab has a **Start** button (flies to stop 1 and opens its popup, whose link gives driving directions to stop 2) and a **Whole route** button.
  - Map tab: the page is locked (`html.lock`). Schedule/Impact/Trip scroll the **document**, vertically only, under a sticky header + tab bar. iMessage's sheet claims every vertical swipe for drag-to-dismiss when the page itself can't scroll, which made inner scrolling panes hard to move. Keep `overflow-x: clip` (not `hidden`, which breaks `position: sticky`). Views under 420 px tall (an inline live card) stay locked and scroll inside the pane.
  - Under 120 px tall (an inline live bubble) it shows a one-line summary only.
  - **Trippy** (`web/trippy.png`), a glossy red car, is the mascot and logo. It appears in the header, the loading, empty and error states, the Trip-tab sign-off, the poll page and the favicon. In messages the agent introduces itself as Trippy only in the welcome and invitation, then just says "I".

### Conversation flow (each member in their own DM)

1. **Onboarding:**
   - `newtrip`, then the host's name.
   - `invite +1…` DMs each invitee, or friends use `join CODE`.
   - `join`, then the member's name.
   - Everyone sends `ready`. Planning needs at least `MIN_MEMBERS` joined and no pending invites.
2. **Planning:** each member answers the 7 predefined fields one by one.
   - Simple answers are parsed deterministically first, and Gemini `PredefinedExtraction` handles the rest.
   - Optional wishes come next, through `OptionalExtraction`. Then `ready`.
   - **Photos** (`phases/photo.ts`): Gemini `ImageInterpretation` (image input plus Google Search) reads a screenshot of a post about a place and records the wish "Visit X, City". It reads a photo of a view and records "Include stops similar to: …". The wish text is built in code. A caption arrives as a separate message in either order; recent DM context plus `awaitingPhoto` keep it from being counted twice. In **review**, a photo becomes feedback ("Add a stop at …" / "Add stops similar to: …") for `FeedbackAssessment`. In other phases photos are declined. Image bytes are fetched from Photon only when used (`runtime.ts`, 7 MB cap) and are never stored.
3. **Voting:**
   - Reconcile first: budget becomes the minimum and dietary restrictions are unioned.
   - Then route and dates polls run, only where members differ, one open poll at a time.
   - A vote is a number, or free text mapped by Gemini `VoteMapping`, or the widget.
   - A tie gets a revote. A predefined poll still tied after the revote **aborts** the trip.
   - Gemini `ConflictAnalysis` then adopts compatible wishes and creates at most 3 bundled polls for real conflicts.
4. **Drafting:** Gemini with Google Search produces `ItineraryDraft`, then geocode, then OSRM, then the deterministic schedule.
5. **Review:** `approve`, or feedback that Gemini `FeedbackAssessment` classifies:
   - **minor**: auto-replan, approvals carry over;
   - **material**: new version, everyone re-approves;
   - **conflicting**: an itinerary poll with a "keep current plan" option.

   Each version is announced with a deterministic diff. When everyone approves, the trip moves to execution and each member gets the dashboard card.
6. **Execution:** Gemini `LiveUpdate` classifies the message:
   - `delay` runs `shiftSchedule` for the same day;
   - `replace_stop` runs `Planner.replaceStop`;
   - `replan_remaining` re-drafts the rest.

   Changes apply immediately, everyone is told, and cards are edited in place.

`help`, `status`, `dashboard` and `cancel` (host only) work in every phase.

**Reminders** (`phases/reminders.ts`, swept every 5 s by `Engine.startReminders`): in onboarding, planning, voting and review, a joined member who owes a step and hasn't answered the agent's last message is nudged after 15 s, then ×4 (1, 4, 16, 64 min), at most 5 times. Each reminder names who is already waiting and for how long. All timing is read from the hypertables (`Repo.reminderState`): the last reply and the unanswered message come from `chat_events`, and reminders sent come from `trip_events` `reminder_sent` rows. A reply or a new phase resets the count.

## Rules that aren't obvious from the code

- **Photon Spectrum (Pro plan), proved by the probe on `dev/initial-scratch`:**
  - Each person DMs their own agent number, and **group chats deliver no events**.
  - The agent can DM registered users first. Numbers not added in the Photon dashboard fail with "Target not allowed"; `invite` reports this and removes the invite.
  - **Native poll votes never arrive.** Don't use `poll()`.
  - Delivery is at-least-once. The `chat_events` insert is the durable dedupe, and `SpectrumChat` keeps an in-memory set.
  - Skip `direction: "outbound"`. Our own sends don't come back on the stream, so `SpectrumChat` records them.
  - Card edits need the original send's `miniAppCardSession`, which the provider **replaces on every edit**. We store `{messageId, session}` on the member (`members.card`), rebuild a minimal outbound target to edit, and save the new session. If the edit fails, we send a new card.
  - Pass `layout` to `app()` so Photon doesn't fetch OG metadata through ngrok.
  - Cards carry Trippy artwork (`web/trippy-card.jpg`) via the layout's `image` + `imageTitle`. Photon only accepts JPEG there. If a card with art fails and the same card without it succeeds, `SpectrumChat` turns the art off for the rest of the process (`card_art_disabled` in the log).
  - **Cards are sent non-live by default (`CARD_LIVE=false`).** A live card (`app(url,{live:true})`) renders the page *inline* in the thread at about reply-bubble size, and the first live test showed it was far too cramped. A non-live card is a normal bubble that should open the mini-app in iMessage's expanded, near-full-screen view when tapped.
  - Free ngrok domains show a "You are about to visit…" page to browsers first. Tap **Visit Site** once.
  - The mini-app webview ignores `target="_blank"` and doesn't open new windows. External links (Google Maps) use the `data-external` handler in `dashboard.js`, which navigates in place when no window opens. Don't add new-window links.
- **Identity and privacy:**
  - Card pages carry no identity. The dashboard is read-only and keyed by an unguessable `publicId`, and `TripDashboard` exposes first names and aggregates only: no handles, no per-person requirements, no who-voted-what.
  - Poll-widget links carry a per-(poll, member) token that is only ever sent in that member's own DM.
  - Polls never say who proposed an option.
- **LLM output is untrusted:**
  - Everything goes through Zod.
  - Gemini may reference only the IDs it was given (a per-call `z.enum`).
  - Distances, times, fuel and CO₂ come from OSRM and code, never from Gemini. Gemini's per-stop prices are shown labeled "Gemini web estimate".
  - Without `GEMINI_API_KEY`, every Gemini step fails with a clear message. **Never** a silent fixture.
  - The only fixtures are in `src/testing/` (tests) and `npm run dev:demo`, whose trip is titled "DEMO DATA".
- **OSM usage policies:**
  - Nominatim allows at most 1 request per second, needs an identifying `GEO_USER_AGENT`, and results are cached.
  - OSRM's public demo server is for light use.
  - Tiles need OSM attribution, which is already shown.
- **Gemini:**
  - Gemini returns HTTP 400 for `minItems`/`maxItems` on nested arrays, so `toLlmJsonSchema` strips them and Zod enforces them after parsing.
  - Structured output combined with the Google Search tool is a **Gemini 3** feature. Keep `GEMINI_MODEL` on a Gemini 3 model (default `gemini-3.8-flash`).
  - Use the Interactions API (`client.interactions.create`, read `output_text`).
- **Out of scope:** bookings, payments, background GPS, calendars, social scraping, Snowflake (per the pitch), voice and images.

## Deviations from the owner's pitch / data flow / user flow

| # | Pitch said | MVP does | Why |
|---|---|---|---|
| 1 | Voting through a poll widget | Polls are numbered text replies in each DM ("reply 1/2/3 or tell me what you'd prefer"), plus a poll-widget card at `/poll/:token` | On Photon **Pro**, native iMessage poll votes never reach the agent (proved by the probe on `dev/initial-scratch`). Card pages carry no identity, so each member's widget link holds a random per-(poll, member) token sent only in their own DM. |
| 2 | Google Maps or OpenStreetMap, whichever is free | OpenStreetMap: Leaflet tiles, Nominatim geocoding, OSRM routing. Google Maps appears only as plain `maps/search` and `maps/dir` (directions to the next stop) links. | OSM needs no billing account or key. Google Maps Platform requires billing. |
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
| 13 | (unspecified) | Text, plus **photos during planning and review**: a screenshot of a place becomes a "visit" wish, and a photo of a view becomes a "stops similar to" wish or feedback. Voice notes and other attachments get a "text only for now" reply. | People share places as screenshots and pictures, which Gemini can read directly. Voice notes would need to be transcoded first (iMessage records them as CAF). |
| 14 | (unspecified) | Planning starts once at least `MIN_MEMBERS` (default 2) people have joined | Stops a host's early `ready` from launching a solo trip. Set it to 1 for solo testing. |
| 15 | Dashboard only after everyone approves | The card is sent to everyone on full approval, as specified, but `dashboard` also works during review as a preview | Lets the group see the map while they decide, without changing the approval flow. |
| 16 | Requirements gathered by the "Planning Phase" | Mid-planning corrections ("actually change my budget to 300") are re-extracted and re-validated | People change their minds, and the predefined schema stays authoritative. |
| 18 | Dashboard layout: map, schedule widget and sustainability icons | A tabbed dashboard (Map / Schedule / Impact / Trip), opened from a **non-live** Photon card, which opens near-full-screen in iMessage (confirmed on device) | The live test showed an inline live card is reply-bubble sized: components were cramped, the schedule scrolled sideways, and the sustainability bars were out of reach. |
| 17 | Gemini drafts the itinerary with web search | At most 12 stops. Stops Nominatim can't find fall back to "name, city", then to the town centre (marked "approx." on the map), then are dropped and listed. | OSM geocoding of businesses is imperfect. Showing what was approximated or dropped is better than inventing coordinates. |
