# HackNC 2026: How road-trip-agent fits each track

road-trip-agent is an iMessage agent that acts as the "group leader" for a friends' road trip:

- Each traveler texts the agent in their own DM.
- It collects everyone's requirements and only puts real disagreements to a vote.
- It drafts an itinerary with Gemini and Google Search.
- It sends a Frutiger Aero mini-app dashboard with a map, a schedule and the trip's carbon and fuel savings.
- On the road, it re-plans live from texts like "we're 30 min late" or "sushi instead of pizza".

This page maps the project to the criteria of each track we entered. It describes the project with all development branches merged (`dev/mvp`, `dev/cooper`, `dev/ui-enhancements`, `dev/demo`). Branch-specific behavior is noted where it matters. Track criteria are quoted or summarized from the [HackNC Tracks page](https://past-cushion-a6f.notion.site/HackNC-Tracks-756816442900834e900c016919f003e8), the [Photon hackathon guidelines](https://somethingreat.notion.site/Hackathon-Guidelines-for-Photon-3dce443f36bb803696daf4135f063cd1) and the [HackNC 2026 Devpost](https://hacknc-2026.devpost.com/).

**Contents:** [General judging criteria](#general-judging-criteria) · [Best iMessage Agent with Photon](#best-imessage-agent-with-photon) · [Best Use of Gemini API](#best-use-of-gemini-api) · [Best Use of Tiger Data](#best-use-of-tiger-data) · [Frutiger Aero Tech](#frutiger-aero-tech) · [Community](#community)

---

## General judging criteria

The Devpost judging criteria are Application/Impact, Functionality/Quality, Creativity, Technical Complexity and Presentation.

### Application / Impact

*"Does the project have any feasible application and/or have a social impact … Will people find value and use your project?"*

- **A real, common problem.** Getting five friends to agree on a trip usually means a long group chat, one person doing all the planning, and someone's budget or diet getting overlooked. The agent does the group-leader work: it collects requirements, settles conflicts fairly, plans the trip and keeps it updated.
- **No install, no sign-up.** It runs in iMessage, where people already plan trips. Friends join by texting `join CODE`, or the host invites them by number.
- **Fair by design.**
  - The trip budget is automatically the lowest one anyone gave, so everyone can afford it.
  - Dietary restrictions are combined, never voted on, so nobody's allergy can be outvoted.
- **Sustainability.** Every trip shows the gas, money and CO₂ the group saves by carpooling instead of driving separately, computed from real routing data.
- **Feasible today.** It runs against real services: Photon iMessage, Gemini, Tiger Data and OpenStreetMap. It has been tested end to end on real iPhones.

### Functionality / Quality

*"Is the project free of major bugs? Does it look appealing?"*

- **Strict validation everywhere.** Every data contract is a strict Zod schema that rejects unknown keys. All Gemini output is re-validated before use, with one repair retry.
- **Tested.** There are unit tests for the pure logic (vote tallying, tie-breaks, scheduling, time zones, sustainability math, diffs). There are also integration tests of the full conversation engine, which run on an in-memory Postgres (PGlite) with the real migrations. `npm run typecheck && npm run lint && npm test` runs all checks.
- **Built for real-world messiness.**
  - Photon can deliver the same message more than once, so the database deduplicates every inbound message.
  - Phase changes are compare-and-set, and work is serialized per trip and per sender.
  - If the server restarts mid-draft, the draft resumes on boot. Shutdown waits for in-flight work to finish (up to 90 s).
- **A polished, touch-first dashboard** (see [Frutiger Aero Tech](#frutiger-aero-tech)). It was iterated on device: the inline card was too cramped, so it became a near-full-screen tabbed view, and scrolling was fixed to work with iMessage's swipe-to-dismiss sheet.

### Creativity

*"Is this project unique and innovative? … A better way of doing something?"*

- **An agent that runs the group.** It doesn't just answer questions. It drives the whole process: onboarding, gathering requirements, voting, drafting, approval and live re-planning.
- **Votes only where people actually differ.** Hard constraints like budget and diet resolve automatically. Related questions are bundled into a single poll, and every poll has an "Either works" option. Gemini checks optional wishes for real conflicts, adopts the ones that are compatible, and creates at most 3 polls for the rest.
- **Three tiers of feedback.**
  - Minor feedback is re-planned automatically.
  - Material changes need everyone to re-approve.
  - Conflicting feedback goes to a vote, with "keep current plan" as an option.
- **Photos as input.** Text a screenshot of a TikTok or Instagram post about a place, and it becomes a "visit X" wish. Text a photo of a view, and it becomes "include stops similar to this".
- **A live trip on the road.** Texting "we're running late" shifts the schedule. Swapping a stop re-plans just that stop. Everyone's dashboard card updates in place.

### Technical Complexity

*"The team should display a good level of knowledge in terms of the technology they've used."*

- **One long-lived Node 24 / TypeScript process.** It holds the Photon Spectrum gRPC stream, a Hono HTTP server and the static dashboard.
- **A phase-based conversation engine** (`src/agent/`). Each DM is dispatched by trip phase. All state lives in the database and handlers re-read it, so the agent is restart-safe. Drafting runs outside the per-trip queue and commits back through it.
- **Clear separation of AI and code.** Gemini decides *what* (which places, what a message means). Code computes *how far* and *when*: geocoding with Nominatim and Photon/Komoot, routing with OSRM, and a deterministic schedule. Gemini never supplies a distance, drive time, fuel or CO₂ number.
- **Latency engineering** (`dev/demo`).
  - While people vote, Gemini research runs speculatively for every possible poll outcome.
  - Each task uses its own Gemini thinking level.
  - Stops are geocoded in parallel through Photon/Komoot, falling back to Nominatim.
  - Together, these cut draft time from about 85 s to about 11 s, and most of that overlaps the vote.
- **Privacy built into the data model.**
  - Dashboard links carry no identity and show only first names and group totals.
  - Poll links use a random per-member token that is only ever sent in that member's own DM.
  - Polls never say who proposed an option.

### Presentation

- A [90-second, two-phone demo script](README.md) (on `dev/demo`), with `npm run demo:up` to start the tunnel and the agent in one command.
- `npm run dev:demo` shows the dashboard and poll widget offline for a seeded trip that is clearly labeled **DEMO DATA**.
- Everything that differs from the original pitch is recorded, with its reason, in the deviations table in [CLAUDE.md](CLAUDE.md). How we used AI tools is described in [AI_USAGE.md](AI_USAGE.md).
- Future work: voice notes (iMessage records them as CAF, which would need transcoding), booking links, and group-chat mode once Photon delivers group events.

---

## Best iMessage Agent with Photon

**Requirement:** *"Projects must integrate Spectrum, Photon's open source framework."* The project uses **`spectrum-ts`** on the Photon Pro plan. [src/chat/spectrum.ts](src/chat/spectrum.ts) is the only module that imports it, and the rest of the app talks to a provider-neutral `ChatPort`.

How we use Spectrum:

| Spectrum feature | How we use it |
|---|---|
| Inbound message stream | One persistent stream, mapped to typed inbound events (text, attachment, voice, reaction, read). Deduplicated, and outbound echoes are skipped. |
| Agent-initiated DMs | `invite +1…` texts each friend first. "Target not allowed" errors are reported back to the host. |
| `app()` mini-app cards | The trip dashboard and the poll widget are sent as iMessage app cards, with an explicit `layout` so Photon doesn't fetch metadata through the tunnel. |
| Editing cards in place | When the plan changes, each member's existing card is updated instead of sending a new message. We store the session token Photon returns on every edit, and send a fresh card if an edit fails. |
| Attachments | Incoming photos are read by Gemini, fetched only when used (7 MB cap) and never stored. On `dev/demo`, a send-off GIF goes to every phone at launch. |
| Typing indicator | Shown while slow steps run (`dev/demo`). |

**Photon's judging criteria:**

- **Vision** (*"Does this push the frontier of hybrid intelligence?"*)
  - The agent is a participant in the trip, not a chatbot. It coordinates several people toward one shared plan.
  - Humans make the calls: votes, approvals and feedback.
  - The agent does the tedious parts: collecting requirements, settling conflicts fairly, researching places, timing the route and re-planning on the road.
- **Craft** (*"Is it cohesive, responsive, and tastefully integrated?"*)
  - It uses iMessage for what iMessage is good at: short texts, numbered replies, photos and one rich card.
  - The card is the itinerary. Changes are announced as a short diff, not as a wall of text.
  - Every user-facing string is in one file ([src/agent/copy.ts](src/agent/copy.ts)), so the tone stays consistent.
  - On `dev/demo`, latency work keeps replies fast: answers are parsed deterministically first, and research runs speculatively during votes.
- **Depth** (*"How well does it handle real-world context and edge cases?"*)
  - Ties get one revote between the tied options. A predefined poll that is still tied cancels the trip with a clear message.
  - Votes can be a number or free text ("whichever's cheaper"), which is mapped to an option.
  - People can correct an answer mid-planning ("actually make my budget 300"). Late joiners work up until voting starts.
  - Stops that can't be geocoded fall back to "name, city", then to the town centre (marked "approx."), and are only then dropped, with the dropped stops listed.
  - Captions that arrive separately from their photo aren't counted twice.
  - Delivery is at-least-once, so the database deduplicates messages.
- **Traction** (*"Can we imagine this running with real users tomorrow?"*)
  - It runs today on real phone numbers, and joining takes one text.
  - It is one long-lived process with a managed Postgres, Tiger Data.

**"What great looks like":**

- **Real human-in-the-loop collaboration.** Every decision belongs to the group: polls, approvals and feedback tiers.
- **Context that persists across time and teammates.** Every message, in and out, is stored per member and per trip in Tiger Data. Live-update and feedback prompts include the member's recent conversation.
- **A delightful default that doesn't demand attention.** Votes only happen where people actually differ, and minor feedback is re-planned without asking anyone.
  - Reminders (`dev/cooper`) only nudge members who still owe a step. They back off over time (15 s, then 1, 4, 16 and 64 min), stop after 5, and say who is waiting.
- **Safety and fallbacks that earn trust.**
  - Gemini output is untrusted and validated, and Gemini can only reference IDs it was given.
  - If no Gemini key is configured, the agent says so clearly instead of quietly using made-up data.
  - Only the host can cancel a trip.
  - Phone numbers never appear in the dashboard or polls, and the database tools show only the last 4 digits.

**Why DMs instead of a group chat:** our capability probe (`dev/initial-scratch`) showed that on Photon Pro, group chats deliver no events and native poll votes never arrive. So each person talks to the agent privately, which also means nobody votes under social pressure. Votes are numbered text replies, plus a per-member poll-widget card.

---

## Best Use of Gemini API

*"Build AI-powered apps that … understand language like a human … analyze info … generate creative content."*

Gemini is the agent's language understanding, vision and research. It is called through the **Interactions API** (`client.interactions.create`, with `store: false`) on a **Gemini 3** model (default `gemini-3.8-flash`), using **structured JSON output combined with the Google Search tool**. That combination is a Gemini 3 capability. The adapter is [src/services/gemini.ts](src/services/gemini.ts).

| Gemini task (schema in [src/schemas/llm.ts](src/schemas/llm.ts)) | What it does | Search grounding |
|---|---|---|
| `PredefinedExtraction` | Reads free-form answers ("leaving Raleigh the 18th, back Sunday, ~$250, I'm vegetarian") into typed requirements | |
| `OptionalExtraction` | Turns wishes ("I want a good hike and BBQ") into categorized optional requirements | |
| `ImageInterpretation` (image input) | Reads a screenshot of a post about a place, or a photo of a view, and turns it into a wish or feedback | ✓ |
| `PlaceCanonicalization` | Cleans typed places to "City, ST" in the background, so "Wilmington" and "Wilmington, NC" don't trigger a vote | |
| `ConflictAnalysis` | Decides which wishes conflict, adopts compatible ones and writes at most 3 bundled polls | |
| `VoteMapping` | Maps a free-text vote to a poll option | |
| `ItineraryDraft` | Researches real places on the route that fit the budget, diet and wishes, and drafts the stops | ✓ |
| `FeedbackAssessment` | Classifies review feedback as minor, material or conflicting, and applies it | ✓ |
| `LiveUpdate` | Classifies a message sent on the road as a delay, a stop replacement or a re-plan of the rest | |
| `ReplacementStop` | Finds a real replacement stop ("sushi instead of pizza") | ✓ |

What makes it a strong use of Gemini:

- **Multimodal.** Gemini reads photos and screenshots, and Google Search identifies the exact place shown in them.
- **Grounded, not invented.** Itineraries come from live web search. Gemini's per-stop prices are shown labeled "Gemini web estimate".
- **Safe structured output.**
  - The schemas are flat because Gemini's JSON-schema subset rejects `oneOf`, and a test enforces this.
  - Array-length bounds are stripped for Gemini (which returns HTTP 400 on them) and checked by Zod after parsing.
  - Gemini can only reference IDs passed to it in that call, enforced by a per-call `z.enum`.
  - A bad response gets one repair retry.
  - If the model rejects search plus JSON together, the adapter falls back to grounded text, then a structured call.
- **Tuned for speed** (`dev/demo`): each task uses its own thinking level, research runs speculatively while people vote, and Google searches are capped at 3 per draft.
- **Clear division of labor.** Gemini picks places and interprets people. OSM routing and code compute every distance, time and emissions number.
- `npm run llm:smoke` checks the key and model with one structured call and one search-grounded call.

> Note: `dev/demo` adds an optional OpenAI Decisions API adapter for a few quick *choice* steps (mapping a free-text vote, sorting a wish, the send-off message) to cut latency. Gemini is the fallback for every one of those steps, and does all extraction, vision, research, drafting and live re-planning.

---

## Best Use of Tiger Data

*"Store relational user profiles and high-frequency metric streams side-by-side in a single database."*

**Tiger Data is the agent's only operational store.** It holds all trip state, every message and every trip event in one Postgres database, accessed through Drizzle over `postgres-js`. The schema is in [src/db/schema.ts](src/db/schema.ts).

- **Relational and time-series data side by side, as the track describes:**
  - **Relational:** `trips`, `members`, `predefined_requirements`, `optional_requirements`, `polls`, `poll_votes`, `poll_tokens`, `itinerary_versions` (each version stored as JSONB and re-validated with Zod on read) and `approvals`.
  - **TimescaleDB hypertables**, partitioned on `occurred_at`:
    - `chat_events`: every inbound and outbound iMessage, per member and per trip.
    - `trip_events`: phase changes, reminders sent, drafts and live changes.

    They are created in [drizzle/0001_hypertables.sql](drizzle/0001_hypertables.sql). The migration is guarded, so the same migrations also run on plain Postgres and PGlite in tests.
- **The hypertables drive the agent:**
  - **Exactly-once processing.** The `chat_events` insert, keyed on `(event_id, occurred_at)`, is how duplicate Photon messages are dropped.
  - **Reminders are time-series queries** (`Repo.reminderState`, `dev/cooper`). For each member, the agent finds their last reply and the agent's unanswered message in `chat_events`, plus reminders already sent in `trip_events`. Every query is limited by trip and time window, and the reminder schedule is computed from the results.
  - **Conversation context.** A member's recent messages are read back from `chat_events` and included in Gemini's feedback and live-update prompts.
  - **When a phase started** is read from `trip_events` `phase_changed` rows.
- **Indexes match the queries:** `(chat_id, occurred_at DESC)`, `(trip_id, occurred_at DESC)` on `chat_events`, and `(trip_id, occurred_at DESC)` on `trip_events`.
- **Ops tooling against Tiger Data:**
  - `npm run db:check` lists tables and confirms the hypertables.
  - `npm run db:tail` shows the latest messages.
  - `npm run db:watch` follows live chat traffic and trip events, with phone numbers masked to the last 4 digits.
  - `npm run trip:peek` inspects the latest trip's itinerary and geocoding.
- **Standard SQL.** It's all plain Postgres and Drizzle, with no separate event store, queue or cache.

---

## Frutiger Aero Tech

*"Blend its signature aesthetic with real sustainability and nature-focused ideas … tools that help people reconnect with the outdoors."*

**The aesthetic.** The dashboard ([web/](web/): plain HTML, CSS and JS, with Leaflet and OpenStreetMap) is built in Frutiger Aero style:

- a blue-sky radial-gradient background, with floating glossy **bubbles**;
- frosted **glass** panels (`backdrop-filter: blur … saturate`);
- glossy **aqua and leaf-green** buttons and tabs, with the classic split highlight gradient;
- bubble-shaped map pins with a specular highlight;
- a poll widget in the same glassy style;
- big, readable tap targets with good contrast.

The aesthetic carries into the chat itself, with emoji-led tabs (🗺️ 📋 🌱 👥) and messages.

**Real sustainability.** The **🌱 Impact** tab shows sustainability "energy bars" computed in code ([src/domain/sustainability.ts](src/domain/sustainability.ts)) from the actual OSRM route distance:

- ⛽ **gas saved by carpooling**: gallons and dollars, compared with every member driving the same route alone;
- 🌍 **carbon footprint cut**: kg of CO₂ per person versus driving alone, at the EPA's 8.887 kg CO₂ per gallon.

The assumptions (mpg, gas price, EPA factor) are printed on the page. No number comes from the LLM.

**Reconnecting with the outdoors.**

- The product's whole purpose is getting friends out of the house and onto the road together.
- Gemini can plan nature stops (hikes, viewpoints, parks) from wishes.
- A photo of a view becomes "include stops similar to this", turning a picture of somewhere beautiful into a real stop.
- The **Start** button flies the map to stop 1 and opens turn-by-turn directions to stop 2 (`dev/ui-enhancements`).

---

## Community

*"Building tools, platforms, and experiences that bring people together and make a real impact … Collaborate, connect."*

- **It exists to bring people together IRL.** The hardest part of a group trip is coordination. The agent removes it, so friends actually go.
- **Every voice counts equally.**
  - Each person talks to the agent privately, so quieter friends aren't drowned out in a group chat.
  - Votes are anonymous: polls never say who proposed an option, and the dashboard never shows who voted for what.
  - Ties get a revote instead of the host deciding.
- **No one gets left out.**
  - The budget is set to the lowest anyone stated, so cost never excludes a friend.
  - Dietary restrictions are combined across the group, so every meal stop works for everyone.
- **Shared, not top-down.**
  - Everyone approves the plan; material changes need everyone's re-approval.
  - Anyone can text a change on the road, and the whole group is told right away.
  - Gentle reminders keep the group moving without anyone having to nag.
- **Good for the wider community too.** Carpooling is built into the trip, and the dashboard shows the group how much fuel, money and CO₂ they saved together.
- **Low barrier.** Anyone with iMessage can join by texting one code. No app, no account and no payment are needed.
- **Respectful of privacy.** The shared dashboard shows first names and group totals only. Phone numbers, individual requirements and individual votes are never shown to the group.
