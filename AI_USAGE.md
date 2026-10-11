# AI Usage

This project was built for HackNC 2026 with heavy help from AI coding tools, mainly Claude (through Claude Code). This page summarizes how we used it, and where people stayed in charge.

## Specs first, then code

We spent a lot of time on hand-written design documents before asking AI to generate any real code. They included:

- **The pitch and user flow:** what the agent does, phase by phase, from the first `newtrip` text to re-planning on the road.
- **A data flow and spec:** the requirement fields, the voting rules, the itinerary shape, and what the dashboard shows.
- **Platform findings:** notes from a hands-on probe of Photon's iMessage platform. These recorded what actually works (DMs, mini-app cards) and what doesn't (group-chat events, native poll votes).

These documents were the main input to code generation. Clear specs let Claude produce code that matched our intent, instead of guessing at it. When the implementation had to differ from the original pitch, we recorded the reason in a deviations table in [CLAUDE.md](CLAUDE.md). That way the specs and the code never silently drifted apart.

## How we worked with Claude

- **A shared project guide.** [CLAUDE.md](CLAUDE.md) is a living document that Claude reads at the start of every session. It holds the architecture, the conversation flow, the non-obvious platform rules, and the pitch deviations. We updated it as the project evolved, so each session started with the full context.
- **Scaffolding and implementation.** Claude generated most of the TypeScript from our specs. This covered the phase-by-phase agent engine, the database schema and queries, the Gemini, map and routing integrations, and the dashboard web pages.
- **Probing before building.** Before committing to a design, we had Claude write small experiments against the Photon platform. Their results shaped decisions like DM-only conversations and text-based voting.
- **Tests alongside code.** Claude wrote unit tests for the pure logic, such as vote tallying, scheduling and sustainability math. It also wrote integration tests that run against an in-memory database. We ran the tests, type checks and linting after each change.
- **Iterating from real use.** We tested on real iPhones and fed what we saw back to Claude: screenshots, error messages and things that felt wrong. Examples include a cramped inline card, hard-to-scroll tabs, and stray HTML entities in titles. Claude diagnosed each one and proposed a fix, and we verified it on device.
- **Design polish.** Claude helped refine the Frutiger Aero look of the dashboard, working from our screenshots and style direction.

## What people decided

AI wrote much of the code, but the team made the product decisions. These included the overall concept and user flow, and which conflicts get a vote and which resolve automatically. The team also chose the privacy rules, the platform and tool choices, and the scope cuts. We reviewed the generated code, tested it on real devices, and rejected or redirected changes that didn't fit the spec.

## AI inside the product

Separately from building it, the agent itself uses Google Gemini at runtime. Gemini reads free-form messages and photos, drafts itineraries with web search, and classifies feedback and live updates. We treat its output as untrusted. Everything is validated against strict schemas. Distances, drive times, fuel and CO₂ figures are always computed in code from OpenStreetMap routing, never taken from the model.
