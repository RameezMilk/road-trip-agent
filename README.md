# road-trip-agent

An iMessage agent (Photon Spectrum) that plays the "group leader" for a friends' road trip:
- it collects everyone's requirements in their own DMs;
- it puts only real disagreements to a vote;
- it drafts the itinerary with Gemini and live web search;
- it iterates on the plan from natural-language feedback;
- when everyone approves, it hands each traveler a Frutiger Aero trip dashboard (OpenStreetMap) as an iMessage mini-app.

See `CLAUDE.md` for the architecture, rules, and every deviation from the original pitch.

## Run it

1. **Prerequisites:** Node 24 and the [Photon](https://app.photon.codes) Spectrum project credentials. Every traveler's number must be added in the Photon dashboard, and every iPhone needs the Spectrum app.
2. Install and configure:
   ```sh
   npm install
   cp .env.example .env
   ```
   Then fill in `.env`:
   - `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`
   - `DATABASE_URL`: the Tiger Data (Tiger Cloud) Postgres connection string
   - `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, which must be a Gemini 3 model)
   - `PUBLIC_BASE_URL`: the public HTTPS URL from `ngrok http 8787`
3. Check the setup:
   ```sh
   npm run llm:smoke   # Gemini key + model work (structured + Google Search)
   npm run db:migrate  # optional: boot also migrates
   ```
4. Start the agent:
   ```sh
   ngrok http 8787     # in another terminal; copy the https URL into PUBLIC_BASE_URL
   npm run dev
   ```
5. From iMessage:
   1. The host texts their agent `newtrip Fall break`.
   2. The host sends `invite +1…, +1…`.
   3. Friends reply `join`.
   4. Everyone replies `ready`.
   5. Everyone answers the questions, then replies `ready` again.
   6. Everyone votes.
   7. Everyone sends `approve` or feedback.
   8. Open the dashboard card.

   On the road, text changes like "we're running 30 min late".

**Try the dashboard without any keys:** `npm run dev:demo` serves a seeded trip that is clearly labeled **DEMO DATA**, using in-memory storage and real OSM routing.

> If the card opens on ngrok's "You are about to visit…" page, tap **Visit Site** once. A reserved ngrok domain or another tunnel avoids it.

## Develop

```sh
npm run typecheck && npm run lint && npm test
```

Tests run fully offline. They use in-process Postgres (PGlite) with the real migrations and scripted fakes for Gemini, geocoding, routing and chat.
