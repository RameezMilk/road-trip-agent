# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

An iMessage group-chat road-trip coordinator for HackNC 2026: plan in the group chat → decide together in a Photon miniapp → run and revise the trip on a shared map. `docs/spec.md` is the build contract (Prompt 1 overrides the Prompt 2 history). Scope: one existing group, three teammates, one vehicle, one day, one corridor.

**Status: capability spike.** We're checking whether Photon groups work on the Spectrum **Pro** plan (shared-pool line) with `npm run probe` and `docs/photon-probe.md`. Gemini, Google Maps, Tiger Data and Snowflake exist only as interface stubs, which throw `NotConfiguredError` or `NotBuiltError`. **Build them only when the owner says so.**

## Commands

```sh
npm install
npm run dev                  # server :8787 (tsx watch) + miniapp :5173 (Vite, proxies /api → :8787)
npm run probe                # Photon capability probe (needs SPECTRUM_* in .env)
npm run probe -- --hello +1…,+1…   # …also DM each registered teammate
npm run probe -- --http-only # probe page/beacon only, no Photon connection
npm run probe:history -- --with +1…  # export a DM's full history from Photon → exports/*.txt + .jsonl
npm run db:migrate           # apply apps/server/drizzle/* to Tiger Data (needs DATABASE_URL)
npm run db:tail -- --limit 50  # latest chat_events rows → console + exports/*.txt
npm run db:generate -w @rta/server  # regenerate SQL after editing src/db/schema.ts (offline)
npm run build                # builds apps/miniapp/dist (served by the server at /trip/*)
npm start                    # server only
npm run typecheck            # tsc --noEmit in every workspace
npm run lint                 # Biome (npm run format to auto-fix)
npm test                     # Vitest, all workspaces
npx vitest run apps/server/src/chat/commands.test.ts -t "parses"   # single file / test
```

App cards need public HTTPS: run `ngrok http 8787` and put the URL in `PUBLIC_BASE_URL` in `.env` (see `.env.example`). Scripts load `.env` from the repo root via `tsx --env-file-if-exists`.

## Architecture

- **npm workspaces, ESM TypeScript, Node 24.** `@rta/contracts` exports TS source (`exports: ./src/index.ts`), which the server (via tsx) and the miniapp (via Vite) import directly. There is no build step between packages. TypeScript is pinned to 6.x because spectrum-ts's peer range excludes 7.
- **`apps/server` is one long-lived Node process:** the Spectrum gRPC message stream, the Hono API, and the built miniapp, all on one origin. Never move it to serverless or edge, because the Spectrum stream must stay connected.
- **`packages/contracts`:** strict Zod schemas from the spec's "anti-slop contract": `TripIntent`, `GroundedPlace`, `StructuredPlan`, `FeasibilityResult`, and so on.
  - Rules: unknown keys are rejected, timestamps must carry an offset, units are in field names (`…Meters`, `…Seconds`, `…Usd`), IDs are prefixed (`trip_`, `cand_`, `loc_`, `part_`, `evt_`), and unknowns are an explicit `null` or `"unknown"`.
- **`apps/server/src/chat/adapter.ts`:** the provider-neutral `ChatAdapter` boundary. The Spectrum implementation (`chat/spectrum-adapter.ts`) gets written after the probe confirms the real field shapes, and **it will be the only non-probe file that imports `spectrum-ts`**. `chat/commands.ts` parses slash commands (syntax only; authorization lives in handlers).
- **`apps/server/src/probe/`:** a standalone capability test that uses spectrum-ts directly on purpose. Logs go to `probe-logs/` (gitignored) with sender handles hashed.
- **`apps/miniapp`:** Vite + React with react-router v8. Views are `/trip/:publicId/{preferences,choices,live}` with a Frutiger Aero visual style (`src/styles.css`). Marker styles are a `Record<MarkerKind, …>`, so adding a new kind won't compile until it's styled.
- **Live chat ingestion:** every Spectrum stream event and every agent send becomes a row in the `chat_events` hypertable (Tiger Data). The flow is `toChatEvent` in `chat/spectrum-adapter.ts`, then `createChatEventSink` in `ingest/chat-events.ts`.
  - Writes are idempotent on `(event_id, occurred_at)`. A failed write is logged, never thrown.
  - The agent's own sends don't come back on the stream, so the probe records them when it sends.
  - Migrations are in `apps/server/drizzle/`. The hypertable step is guarded so it's a no-op on plain Postgres. Tests use PGlite (in-process Postgres), so no database is needed to run `npm test`.
- **Data ownership (from the spec):**
  - Tiger Data (Postgres via Drizzle, `apps/server/src/db/`) is the only operational store: relational tables plus a `trip_events` hypertable.
  - Snowflake holds only the curated public corridor corpus, queried with Cortex Search over REST.

## Rules that aren't obvious from the code

- **Identity:** app cards carry no sender identity. Miniapp submissions are anonymous drafts, committed only by `/confirm CODE` from the verified chat sender. A code is used once, expires, and is bound to trip, action and plan version.
  - No GET-by-confirmation-code endpoint.
  - No private values in card URLs.
  - No "vote as" dropdowns.
- **Spectrum:**
  - Delivery is at-least-once, so dedupe on `message.id`, and skip `direction: "outbound"`.
  - `attachment.read()` downloads again on every call.
  - Voice memos arrive as `voice` or as an `audio/*` attachment.
  - To update an app card, `edit(app(url,{live:true}), sentMessage)`.
  - On Pro there is no group creation and no membership events.
  - The agent stays quiet on non-command chat.
- **LLM output is untrusted.**
  - Gemini returns contract-shaped JSON that code validates, and it may reference only the candidate IDs it was given.
  - Distances, times and costs come from Routes, Places and deterministic code, never the LLM. Feasibility is computed, not asserted.
  - Fixtures must be visibly labeled and never silently used in a live demo.
- **Google:**
  - Use Places API (New) and Routes API only; the legacy Places and Directions APIs are unavailable to new projects.
  - Advanced Markers need a Map ID.
  - Places results must render on a Google map with attribution. Persist only place IDs. Photo names expire.
  - Eco routing can't take intermediate waypoints, and its EV figure is fuel-equivalent, not kWh.
  - There are two keys: `GOOGLE_MAPS_SERVER_KEY` stays on the server, and `GOOGLE_MAPS_BROWSER_KEY` is referrer-restricted.
- **Gemini:** the docs now recommend the Interactions API (`generateContent` is legacy). iMessage `.caf` voice notes must be transcoded before Gemini can read them.
- **Decisions API:** `ENABLE_DECISIONS_API=false` by default (`domain/decision-engine.ts`). No vendor is chosen, so never fabricate its SDK or substitute another LLM.
- **Out of scope:** bookings, payments, background GPS, calendars, social-account scraping, Solana.

## Nessie (future-only)

`apps/server/src/domain/budget-provider.ts` marks where a Capital One Nessie sandbox adapter could later supply trip-fund budgets and expense categories. In the MVP the stub returns `not_implemented`: no credentials, network calls, accounts or payment UI. User-entered budgets work without it, and sandbox data must never be presented as real banking. Nessie is not an MVP integration or prize entry.
