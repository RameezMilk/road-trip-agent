# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

An iMessage road-trip agent for HackNC 2026 (Devpost due 10:00 AM ET, Oct 11 2026). It acts as an automated "group leader":
- Each traveler texts the agent in their own DM.
- The agent collects everyone's requirements and runs votes only where people differ.
- It drafts an itinerary with Gemini and web search, then iterates on it from natural-language feedback.
- When everyone approves, it sends a Photon mini-app dashboard with a map, a schedule and sustainability bars.
- On the road, it re-plans live from messages like "we're 30 min late" or "sushi instead of pizza".

`dev/mvp` was started fresh from `main`. **`dev/demo`** branches off `dev/mvp` and tunes the flow for a 90-second live judge demo (Rameez + a judge, two phones), so it is fast, short and bulleted. The README has the script and a pre-flight checklist. The earlier `dev/initial-scratch` branch (the Photon capability probe and spec-era scaffold) is **reference only** and is never merged. Its probe findings are summarized under "Rules" below.

**Status:** MVP live-tested on phones. `dev/demo` is built and tested offline (fakes plus PGlite) and runs live with `npm run demo:up`. Live use needs `GEMINI_API_KEY` and a Tiger Data `DATABASE_URL` in `.env`; `OPENAI_API_KEY` (Decisions API) is optional, and Gemini is the fallback.

## Commands

```sh
npm install
npm run dev            # agent + HTTP on :8787 (tsx watch). Needs DATABASE_URL; runs migrations on boot
npm start              # same, without watch
npm run demo:up        # Cloudflare quick tunnel (ngrok fallback) + agent with PUBLIC_BASE_URL and MAX_STOPS=6 set
npm run dev:demo       # dashboard + poll widget for a seeded, visibly labeled DEMO DATA trip (in-memory PGlite, no keys)
npm run db:migrate     # apply drizzle/* to Tiger Data (boot also does this)
npm run db:generate    # regenerate SQL after editing src/db/schema.ts (offline)
npm run db:tail -- --limit 50   # latest chat_events rows (handles shown as last 4 digits)
npm run llm:smoke      # structured, grounded and draft Gemini calls with timings (checks key, model, latency)
npm run typecheck && npm run lint && npm test
npx vitest run src/agent/engine.test.ts -t "aborts"   # single test
```

Cards need public HTTPS. `npm run demo:up` starts a tunnel and passes its URL as `PUBLIC_BASE_URL`; by hand, run `ngrok http 8787` and put the URL in `.env`. Scripts load `.env` via `tsx --env-file-if-exists=.env`.

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
  - **Speculative research:** when polls open, `Engine.speculate` starts `planner.research` for every possible outcome (at most 4). The first draft uses the one whose `draftKey` matches the final requirements; `decisions` are excluded from the key.
  - Every user-facing string is in `copy.ts`.
- **`src/domain/`** holds pure, unit-tested logic:
  - `answers` and `dates` are the deterministic readers for the planning questions: route, budget plus diet, "nope", and date ranges with fuzzy month names.
  - `reconcile` compares requirements and builds polls.
  - `tally` picks the winner and handles revotes and tiebreaks.
  - `schedule` computes times, `shiftSchedule` and `rescheduleFrom`.
  - `sustainability`, `diff`, and `time` (time-zone math with no library).
- **`src/services/`**:
  - `Llm` port, implemented by `GeminiLlm`. It uses the Interactions API with `store:false` and a JSON `response_format`, plus the Google Search tool when `webSearch`. Each task runs at a thinking level (`DEFAULT_EFFORT`). Results are Zod-validated with one repair retry, and the grounded-text-then-structured fallback is used if the combination fails.
  - `Decider` port (`decisions.ts`), implemented by `OpenAiDecider` (OpenAI Decisions API, `POST /v1/decisions`, `gpt-6-luna`). It only *chooses* among given options or returns a probability, and never extracts text. `null` (no key, refusal, error, 2.5 s timeout) sends the caller to its Gemini path.
  - Geocoding is `FallbackGeocoder(PhotonGeocoder, NominatimGeocoder)`:
    - Komoot Photon runs in parallel, and a hit counts only if its name and city match the query;
    - Nominatim follows at 1 req/s with an identifying User-Agent. Both are cached.
  - `OsrmRouter`: one multi-waypoint call, with a haversine fallback labeled `estimate`.
  - `Planner`: `research` (Gemini picks places), then `place` (OSM locates them in parallel, and code computes every number). `draft` runs both.
- **`src/chat/`**:
  - `ChatPort` is the provider-neutral boundary. `NameDirectory` (`PhotonUsers`) supplies first names from the Photon project's users list (Spectrum REST API, Basic `projectId:projectSecret`).
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

1. **Start and join:**
   - `newtrip` creates the trip directly in `planning`. The host gets three bubbles: the intro, `join CODE` on its own so it can be forwarded, and "Hey Rameez! 📍 Where from, and where to?".
   - Friends send `join CODE`, or `join` after an `invite +1…`, and go straight to "📍 Where to?". The host hears "👋 Sam joined!".
   - First names come from the Photon project's users (`PhotonUsers`, `GET /projects/{id}/users/`, cached). Only someone with no first name on file is asked "What's your first name?".
2. **Planning:** 3 grouped questions cover the 7 must-haves:
   - 📍 route: **the host** gives start and destination ("Chapel Hill to Wilmington"; a lone place is their start, then "And where to?"). **Guests** only name a destination, and their start is the host's (`syncHostStart`). Every trip is a **round trip** and it's never asked; "one way" is ignored and never read as a place;
   - 📅 dates: one message, e.g. "Oct 18–19";
   - 💵🥗 budget plus diet: "$300, halal".

   Each answer is read **deterministically first** (`domain/answers`, `domain/dates`); Gemini `PredefinedExtraction` only gets what those can't read. A typed route is cleaned to "City, ST" in the background (`PlaceCanonicalization`). Then "✨ Anything else?": one message, either "nope" or a wish (sorted by Decisions, Gemini fallback), finishes the member. A `ready` message isn't needed.
   - **Photos** (`phases/photo.ts`): Gemini `ImageInterpretation` (image input plus Google Search) reads a screenshot of a post about a place and records the wish "Visit X, City", or a photo of a view and records "Include stops similar to: …". The wish text is built in code. Mid-questions the photo is saved and the next question follows; as the answer to "✨ Anything else?" it finishes the member, like a text wish. A caption arrives as a separate message in either order: before the photo it gets "📸 Send the picture" (`refersToPhoto`, so it's never read as a place or a wish); within 2 min after it, `Engine.receive` drops it (so it can't count as a vote once the photo started voting). In **review**, a photo becomes feedback ("Add a stop at …" / "Add stops similar to: …") for `FeedbackAssessment`. In other phases photos are declined. Image bytes are fetched from Photon only when used (`runtime.ts`, 7 MB cap) and are never stored.
3. **Voting** starts when ≥ `MIN_MEMBERS` have joined, no invite is pending, and everyone has finished:
   - Reconcile first: budget becomes the minimum, dietary restrictions are unioned, and "Wilmington" equals "Wilmington, NC".
   - Wishes: 0–1 always fit; otherwise a Decisions predicate checks them, with Gemini `ConflictAnalysis` as the fallback.
   - Route and dates polls run only where members differ, one open poll at a time. A vote is a number or free text (Decisions first, then Gemini `VoteMapping`).
   - A tie gets a revote. A predefined poll still tied after the revote **aborts** the trip.
4. **Drafting:** the research is usually already done speculatively. Then geocoding (Photon, then Nominatim), OSRM, and the deterministic schedule.
5. **Launch** (`REVIEW_STEP=false`, the default): each member, in parallel, gets "✅ Itinerary ready!", the dashboard card, a send-off ("🏖️ You're set for Wilmington!" plus a line chosen by Decisions from the destination's vibe) and `DAP_GIF_PATH`.
   - With `REVIEW_STEP=true`, the card is followed by "reply approve". Feedback is classified by Gemini `FeedbackAssessment`:
     - **minor**: auto-replan, approvals carry over;
     - **material**: new version, everyone re-approves;
     - **conflicting**: an itinerary poll.
   - Revisions text a bulleted diff and edit the card. Full approval sends the send-off and GIF. **The itinerary is never sent as text.**
6. **Execution:** Gemini `LiveUpdate` classifies the message:
   - `delay` runs `shiftSchedule` for the same day;
   - `replace_stop` runs `Planner.replaceStop`;
   - `add_stop` runs `Planner.addStop`: Gemini (with Google Search) finds the real place, OSM locates it, and it goes between the stops still ahead where it adds the least driving (straight-line cheapest insertion, then OSRM re-times everything after it). Nothing is dropped, however far off the route it is;
   - `change_trip` (new dates or destination, e.g. "add an extra day") sends the trip **back to a vote**: phase `voting`, one `itinerary` poll "Change the trip: add 1 day (ends Mon, Oct 19)?" with Yes / "No — keep the current plan". Yes re-plans the rest with the new end date/destination (`Revision.backToRoad` + `tripChange`, applied to `resolved` only when the new plan is saved) and the trip goes straight back to `execution` with a diff and edited cards; No, or a tie after the revote, keeps the plan (`tiebreak` prefers `KEEP_CURRENT`). A destination outside the US is declined;
   - `replan_remaining` re-drafts the rest, and a re-plan that would drop every stop is refused.
   - **A photo** ("saw this on Instagram, let's go here") goes through `ImageInterpretation` (caption included), then the place itself, or a real place like the view, is added with `Planner.addStop` (`execution.photoStop`).

   Changes apply immediately, everyone is told, and cards are edited in place.

`help`, `status`, `dashboard`, `cancel` (host only) and `leave` work in every phase.

**Leaving** (`phases/leave.ts`): a member who texts `leave` (or "I don't want to go anymore", which asks them to confirm with `leave`, so it can never be read as a change to everyone's plan) gets status `left`: nothing counts them any more (answers, votes, approvals, reminders, the dashboard crew), and their votes on open polls are withdrawn. The trip carries on: a vote only waiting on them closes (`voting.recheckOpenPoll`), planning moves to the vote, an approval round completes, and the final requirements are re-reconciled without them. The host can't leave (`cancel` ends the trip).

**Trips are US-only.** While planning, `PlaceCanonicalization` (background, for every typed route) flags a place outside the US; it's cleared and the member is asked again ("🇺🇸 I only plan road trips within the US."). Ambiguous names prefer North Carolina ("Wilmington" → "Wilmington, NC"). On the road, `change_trip` to a non-US destination is declined.

**Privacy in chat:** "Where does Rameez wanna go?" gets "🤫 Everyone's picks stay secret until the vote!" plus the member's own question (`asksAboutOthers`, no Gemini call).

**Reminders** (`phases/reminders.ts`, swept every 5 s by `Engine.startReminders`): only when someone is already waiting on the member (a host alone in a new trip, or a vote nobody has answered, gets no nudge). In onboarding, planning, voting and review, a joined member who owes a step and hasn't answered the agent's last message is nudged after 15 s, then ×4 (1, 4, 16, 64 min), at most 5 times. Each reminder names who is already waiting and for how long. All timing is read from the hypertables (`Repo.reminderState`): the last reply and the unanswered message come from `chat_events`, and reminders sent come from `trip_events` `reminder_sent` rows. A reply or a new phase resets the count. In planning a reminder repeats the member's current grouped question (or "✨ Anything else?"). An unanswered message older than 2 hours is ignored, so abandoned trips never ping anyone. `REMINDERS=false` turns them off (e.g. for a tightly scripted live demo, where a 15 s nudge can land mid-explanation).

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
  - Free ngrok domains show a "You are about to visit…" page to browsers first. The `ngrok-skip-browser-warning` header only helps requests we make, i.e. the dashboard's `fetch` calls, which send it. iMessage loads the card page itself, so that first load can't carry the header. `demo:up` therefore prefers a Cloudflare quick tunnel, which has no such page. Where trycloudflare.com is blocked (it timed out on the hackathon network), it falls back to ngrok, and each phone taps **Visit Site** once (remembered for 7 days).
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
  - Komoot Photon (`photon.komoot.io`) is fair use: one request per stop per draft, cached, with the same User-Agent. It happily returns a same-name place in another city, so `photonHitMatches` checks name and city.
  - OSRM's public demo server is for light use.
  - Tiles need OSM attribution, which is already shown.
- **Gemini:**
  - Gemini returns HTTP 400 for `minItems`/`maxItems` on nested arrays, so `toLlmJsonSchema` strips them and Zod enforces them after parsing.
  - Structured output combined with the Google Search tool is a **Gemini 3** feature. Keep `GEMINI_MODEL` on a Gemini 3 model (default `gemini-3.8-flash`).
  - Use the Interactions API (`client.interactions.create`, read `output_text`).
  - **Thinking level is the latency knob.** With the default thinking level, the grounded draft took 74–86 s; at `thinking_level: "low"` it takes about 11 s (`npm run llm:smoke`).
    - `gemini-3.8-flash` rejects `"minimal"`, so `GeminiLlm` remembers rejected levels and steps up to the next one.
    - Small structured calls still take 2.5–5 s, so chat replies avoid Gemini whenever a deterministic reader works.
- **OpenAI Decisions API** (public beta since 2026-10-06, `openai` ≥ 7.30, `client.decisions.create`):
  - It supports `choice`, `predicate` and `score` questions only. Use it to pick among known options, never to extract values.
  - Answers can be `refusal`. A refusal, a value it wasn't offered or low confidence means "ask Gemini".
  - `.env` may still contain `ENABLE_DECISIONS_API=false` from the old scratch branch. Nothing reads it: `OPENAI_API_KEY` alone turns Decisions on.
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
| 12 | (unspecified) | Each member's first name is taken from their Photon user record (`firstName`), and asked only if Photon has none | Polls, status messages and the dashboard show first names, never phone numbers. |
| 13 | (unspecified) | Text, plus **photos during planning, review and on the road**: a screenshot of a place becomes a "visit" wish, and a photo of a view becomes a "stops similar to" wish or feedback; on the road either one becomes a new stop. Voice notes and other attachments get a "text only for now" reply. | People share places as screenshots and pictures, which Gemini can read directly. Voice notes would need to be transcoded first (iMessage records them as CAF). |
| 14 | (unspecified) | Planning starts once at least `MIN_MEMBERS` (default 2) people have joined | Stops a host's early `ready` from launching a solo trip. Set it to 1 for solo testing. |
| 15 | Dashboard only after everyone approves | The card is sent to everyone on full approval, as specified, but `dashboard` also works during review as a preview | Lets the group see the map while they decide, without changing the approval flow. |
| 16 | Requirements gathered by the "Planning Phase" | Mid-planning corrections ("actually change my budget to 300") are re-extracted and re-validated | People change their minds, and the predefined schema stays authoritative. |
| 17 | Gemini drafts the itinerary with web search | At most 12 stops. Stops Nominatim can't find fall back to "name, city", then to the town centre (marked "approx." on the map), then are dropped and listed. | OSM geocoding of businesses is imperfect. Showing what was approximated or dropped is better than inventing coordinates. |
| 18 | Dashboard layout: map, schedule widget and sustainability icons | A tabbed dashboard (Map / Schedule / Impact / Trip), opened from a **non-live** Photon card, which opens near-full-screen in iMessage (confirmed on device) | The live test showed an inline live card is reply-bubble sized: components were cramped, the schedule scrolled sideways, and the sustainability bars were out of reach. |
| 19 | Ask the predefined requirements one by one | 3 grouped questions (route · dates · budget + diet). Answers are read deterministically first; dates take abbreviations and misspellings ("Octobr 18 to 19"); Gemini reads the rest. | A 90-second demo can't afford 7 turns per person, or Gemini's 2.5–5 s per answer. |
| 20 | Everyone sends `ready` before planning | `newtrip` starts in `planning`; people answer as soon as they've joined; voting waits for ≥ `MIN_MEMBERS`, no pending invites and everyone finished | Removes two turns per person and the dead time while the host waits. Late joiners now work until voting starts. |
| 21 | Optional wishes: as many messages as you like, then `ready` | One "Anything else?" answer: "nope" or a wish. Either finishes the member. | One turn instead of two or more. Later messages are still added as wishes until the vote. |
| 22 | Round trip or one way is asked | **Round trips only**, never asked; "one way" is ignored | Owner decision: plan round trips only. Saves a turn and a field. One-way support stays in the planner and schemas. |
| 23 | (unspecified) | Typed places are cleaned to "City, ST" by Gemini **in the background**; reconcile treats "X" and "X, ST" as one place | Deterministic parsing keeps raw text, and a spurious "Wilmington vs Wilmington, NC" vote would kill the demo. |
| 24 | Use OpenAI's Decisions API to cut latency where it fits | `OpenAiDecider` for free-text votes, sorting the "anything else?" wish, the wish-compatibility check, and the send-off vibe. Gemini is the fallback for every one. | Decisions only *chooses*, so it replaces exactly the Gemini calls that were choices (`VoteMapping`, `OptionalExtraction` on this path, most `ConflictAnalysis` runs). |
| 25 | (unspecified) | Gemini research runs **speculatively** for every possible poll outcome while people vote; per-task thinking levels; `MAX_STOPS` (6 in the demo); Photon parallel geocoding | Drafts took ~85 s. Now about 11 s of research overlaps the vote, and placing takes about 1–2 s. |
| 26 | Dashboard after everyone approves | `REVIEW_STEP=false` (demo default): the first itinerary goes straight to the road. `REVIEW_STEP=true` restores approve, feedback and polls. | The owner chose to skip the approve turn for the demo. The review tiers stay intact behind the flag. |
| 27 | (itinerary shown in chat) | **No itinerary text:** "✅ Itinerary ready!", then the card. Revisions and live changes text only a bulleted diff. | The owner asked for a short message plus the mini-app. The card is the itinerary. |
| 28 | (unspecified) | A send-off ("🏔️ You're set for Asheville! … pack a jacket 🧥") plus the dap GIF on every phone at launch | The demo's ending, requested by the owner. The line comes from a deterministic table keyed by the destination's vibe. |
| 29 | Poll widget for voting | `POLL_WIDGET=false`: votes are iMessage replies only. The widget page and API remain. | Owner request: vote by texting. The feature is disabled, not deleted. |
| 30 | Dashboard hosted on ngrok | `demo:up` uses a Cloudflare quick tunnel and falls back to ngrok | Cloudflare quick tunnels show no browser warning page. The ngrok header can't be attached to iMessage's own page load. |
| 31 | Everyone gives a start and an end; differing routes are voted on | **The host sets the start** for everyone. Guests are asked only "Where to?", and the route poll lists destinations only | Owner decision. The group leaves from one place, and the vote is simpler. |
| 32 | Ask each person's name | Names come from the Photon users list, so nobody is asked unless Photon has no first name for them | Owner decision: Photon already stores registered users' names. One cached list call; on failure the agent just asks. |
| 33 | (unspecified) | Any member but the host can `leave`; the trip carries on without them (votes, waits and approvals stop counting them) | Owner request: someone dropping out mustn't stall or disrupt the group. "I don't want to go anymore" once emptied a trip for everyone via a re-plan. |
| 34 | Changes on the road apply immediately (#10) | Except changes to the trip's **dates or destination** ("add an extra day"): those go back to a quick group vote; a tie keeps the plan | Owner decision: those are the group's call, like the original route/dates votes. |
| 35 | (unspecified) | Road trips are **US-only**: non-US places are declined while planning and on the road | Owner decision. The geocoders are US-only anyway. |
