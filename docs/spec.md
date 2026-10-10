> **Provenance:** This is the build handoff, verbatim, as pasted into Claude Code on 2026-10-10. It arrived in two pastes: the second restarted at the command table and had lost its line breaks, so they were restored here. **Prompt 2 was cut off after §2 when pasted.** Where this document and `CLAUDE.md` disagree, the more recent decision wins; `CLAUDE.md` records project-specific decisions made since.

# Claude Code handoff: the road-trip agent

Prepared October 10, 2026. Paste both prompts below into one Claude Code request in Plan Mode. Prompt 1 is the current build contract; Prompt 2 explains the road-trip discussion and superseded ideas. This is a specification, not a claim that integrations have been implemented or tested.

## Prompt 1 - Primary prompt: plan and build the scoped MVP

You are our product-minded technical lead for a HackNC project. Start in Plan Mode, inspect this repository and `CLAUDE.md`, and propose a concrete implementation plan before writing application code. Once implementation is authorized, build the vertical slice through completion. Make routine implementation decisions yourself. Ask only about facts that materially block real integrations, such as missing Photon entitlement, credentials, or the unidentified Decisions API provider.

### Product promise and priorities

Build an AI-enabled road-trip coordinator that lives in the existing iMessage group chat with our friends. The product has three phases: **Plan in the chat -> Decide together in a miniapp -> Execute and revise through a shared map dashboard**. A group turns an inspiration image and a few constraints into a real itinerary, votes on stops, and sees that itinerary repair itself when a constraint changes.

Our first priority is a polished, reliable entry for **Best iMessage Agent with Photon**. Make Spectrum integral to the experience, with real group messages, native app cards, human decisions, and persistent trip context. Additional track integrations should strengthen that experience. We are pursuing all five MLH tracks other than Solana, plus Frutiger Aero Tech. Winning is an objective, not a guarantee.

Use Gemini as the main LLM. Use Tiger Data for canonical application state and Snowflake's API for meaningful public-knowledge retrieval. Use Google Maps, Places, and Routes for the MVP. Elsewhere is a provisional working name; no name or domain availability is asserted.

### Hard scope boundary

- Three consenting teammates, one existing iMessage group, one vehicle, one day, and one prepared road-trip corridor. Chapel Hill to Asheville is a proposed scenario; resolve actual places and travel times before choosing the final demo.
- Exactly two restaurant choices and two scenic/interesting-stop choices by default. Add at most one rest stop and one necessary compatible charging stop. Evaluate this small candidate space well; do not build a worldwide itinerary optimizer.
- Support gas and one explicitly configured Tesla EV preset. Demonstrate one vehicle mode end to end; keep the other mode working as a small alternate scenario.
- Accept text and one inspiration photo/screenshot. Support a voice-note input through the same extraction adapter, without creating a separate conversational voice interface. Social links are optional inputs; an inaccessible reel should prompt for a screenshot or clip.
- Deliver preferences/voting and execution views inside Messages using Photon miniapps. No standalone consumer website or mobile app is required to complete the trip flow.
- Include a final human approval and one meaningful replan that visibly updates the same trip/dashboard.
- Hotel, restaurant, rest, scenic, attraction, and charging icons belong to the marker system. A hotel icon does not imply multi-day lodging search or hotel booking is in scope.
- No bookings, real payments, background GPS tracking, calendar integrations, arbitrary social-account scraping, Solana, or live Nessie integration.

### 1. Planning phase: the group chat is home

The friends add our dedicated agent number to their existing GC. Continue using that GC throughout the demo. Private DMs and creation of another trip group must not be prerequisites for the current MVP.

Build a small documented command parser. Slash commands are text our backend interprets; do not promise an iOS-native command menu or autocomplete.

| Command | Behavior |
|---|---|
| `/trip <origin> to <destination>` | Create a draft associated with this group; identify the host from the actual incoming sender. |
| `/join` | Explicitly join the group's active trip. Membership in the GC alone is not a preference submission. |
| `/inspire` | Interpret an attached image or the immediately associated, bounded group attachment. |
| `/plan` | Resolve missing inputs, calculate the baseline, retrieve candidates, and publish the preference/options card. |
| `/vote <option-id> [like\|pass\|must\|clear]` | Sender-backed fallback for preference voting; omitted state means Like. |
| `/confirm <code>` | Commit a versioned miniapp draft using the real chat sender when the miniapp identity bridge is unavailable. |
| `/approve <version>` | Host approves the displayed feasible itinerary for that exact version. |
| `/map` | Open the shared execution view for the current trip. |
| `/done <stop-id>` | Host/driver marks a stop complete using a confirmed location/time. |
| `/replan <change>` | Extract the requested change and produce a revised proposal. |
| `/status`, `/help`, `/cancel` | Concise status, visible command help, and host-controlled cancellation. |

Allow natural-language changes after the trip exists, but do not answer every casual message. Respond when invoked or when a trip decision needs attention. Keep group messages short, specific, and useful. A single status message/card should explain progress; do not flood the group with internal tool logs or generic enthusiasm.

Before planning, obtain origin/destination, date and timezone, departure, latest arrival, allowed extra driving, stop-time allowance, meal-spending scope, and vehicle assumptions. Ask compact follow-ups for genuinely missing data. Announce any proposed demo defaults and let the group confirm them; never silently invent dates, budgets, or vehicle telemetry.

Baseline/discovery work may run while preferences are being gathered. Publish the preference form first; do not open an eligible-choice ballot until the enrolled participants' hard preferences have been confirmed. Early discovery results are provisional, not a claim that they satisfy everyone.

### 2. Iteration phase: one miniapp, clear choices

Build one branded, mobile-first miniapp with **Preferences**, **Choices**, and **Live Trip** views. Expose the views through dedicated app cards in the GC. Use Photon `app(url, { live: true })`; the supported Spectrum launcher is installed once before the stage demo. Do not build a new native iMessage extension for the MVP. Retain the returned card message for supported in-place updates. See [Photon app cards](https://photon.codes/docs/spectrum-ts/content/app).

Choose the MVP interaction now: compact interest chips and small MCQs for preferences, then image cards with explicit **Like / Pass / Must-have** taps. Optional swipe animation can enhance the cards later; swipe gestures must not be required. Show two choices per active category, not an endless feed.

Each stop card must show a verified name, permitted photo or designed illustration, reason for matching the group's inspiration, added driving, visit duration, cost scope/uncertainty, and arrival/opening fit. Include an identifiable option ID and plan version. Avoid large AI-written paragraphs. Use meaningful loading, empty, retry, and unavailable states.

Distinguish a hard requirement from a preference. A hard requirement is explicitly supplied/confirmed; a Must-have vote is still subject to feasibility. Missing responses remain pending. Aggregate compatible preferences to prepare a proposal; a popular stop never overrides a confirmed dietary, accessibility, time, budget, or vehicle constraint.

Use the custom miniapp as the primary decision experience. Native Spectrum polls are a fallback when the target phones support them; `/vote` is the text fallback. Do not maintain competing ballot sources at once. Native polls permit multiple selections and changing votes; normalize their events rather than treating them as exclusive MCQs, secret ballots, or final approval. Unknown user-added choices need grounding before becoming eligible. See [Spectrum polls](https://photon.codes/docs/spectrum-ts/content/polls) and [Apple poll behavior](https://support.apple.com/guide/iphone/poll-people-in-a-conversation-iphde1787df4/ios).

Voting policy: one current Like/Pass/Must-have state per participant and candidate, or no vote. Count Like and Must-have as positive preferences, then use disclosed deterministic route fit to break ties. Must-have also requests a constraint; it requires confirmation before becoming hard, and conflicting requests produce an explicit tradeoff. Preserve abstentions. The host closes the ballot when the enrolled demo participants are ready and separately approves the recomputed final route. Show dissent or pending input accurately rather than claiming unanimous agreement.

### Miniapp identity and privacy contract

All entry points remain in the GC, but a shared bubble is not a private or authenticated form. A participant name in a URL, a client-supplied ID, and a shared bearer link are not proof of identity. Verify an actual Photon-supported identity/group-context bridge server-side if one exists; current public app-card documentation does not establish it.

If that bridge is unavailable, implement the same-GC fallback: the miniapp creates an anonymous short-lived draft, then the traveler sends `/confirm CODE`. Bind its one-use nonce to trip, action, plan version, and expiry. Commit the draft to the verified incoming sender, never a name supplied by the form. This authorizes that submitted action; it does not establish a permanent browser login. A browser-only vote stays pending until authenticated or confirmed in chat.

A public confirmation code must never retrieve raw draft contents. Use a separate browser-only receipt for viewing/editing the anonymous draft, plus random, expiring, rate-limited confirmation codes. Once confirmed, shared endpoints expose only readiness and permitted aggregates. Never implement a public `GET /draft/:confirmationCode` that returns private answers.

Never place private values in the shared card URL or nonce. The shared view exposes readiness, eligible choices, aggregate results, and itinerary facts. It must not return saved private answers or another traveler's form state. In the fallback, provide fresh forms for changes rather than prepopulating private saved answers from a shared link. Keep individual raw submissions out of group-generation prompts and public logs. Group-text preferences are visibly shared; warn at the input point before collecting sensitive detail there. Do not promise perfect anonymity from recommendations in a small group.

Treat membership, sender mapping, replay prevention, cross-trip isolation, and stale votes as real backend logic. No guest dropdown that can vote as any friend. Expire drafts and reject nonmember, duplicate, expired, or wrong-version actions. Explain the limited confirmation fallback honestly and test it on actual phones.

### 3. Execution phase: the shared live trip dashboard

Open the execution dashboard inside Messages from the GC card or `/map`. Use Google Maps JavaScript API, provider-generated polylines, and custom categorical markers. Provide a mobile map/list toggle, ordered timeline, current ETA, driving miles, detour minutes, visit/buffer time, estimated trip cost, fuel/energy assumptions, plan version, and last-updated time. Tapping a marker reveals the corresponding canonical stop card.

Use an explicit marker enum: `restaurant`, `rest`, `hotel`, `scenic`, `attraction`, `charging`; provide clear selected/unselected/current-stop states, a legend, and labels accessible without relying only on color. Show origin/destination differently from optional stops. No invented coordinates or decorative pins that imply verified venues.

Use Google Advanced Markers or the currently supported equivalent. Google Places results displayed on a map must use Google Maps with attribution. OpenStreetMap/MapLibre is a future separately permitted POI/routing stack, not a tile substitution underneath Google Places results. [Maps marker documentation](https://developers.google.com/maps/documentation/javascript/advanced-markers/html-markers), [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies).

"Live" means shared persisted state updates while the miniapp is open. Poll our backend approximately every 10-15 seconds or use a simple verified push connection; pause refresh when hidden. Call expensive external route services on relevant changes, with deduplication and bounded refresh. Do not equate a live miniapp with live GPS, background execution on an iPhone, or measured EV telemetry.

Support a manual stop-complete action and `/replan` for a changed deadline, budget, or stop. During replanning, keep the previous approved itinerary visible. Show only the meaningful changed decisions. After approval, update the same shared dashboard and send one concise change summary to the GC.

Before departure, replan from the confirmed origin/departure. Once the host/driver explicitly marks departure or a stop complete, retain completed stops as history and plan only the remaining journey from an explicitly confirmed location/time. Request those facts if missing; do not infer vehicle movement or re-add completed stops. Miniapp progress writes require the same verified sender/action authorization as other changes.

### Typed, grounded planning: the anti-slop contract

Schema-bound extraction is necessary but does not make facts true. Use shared TypeScript/Zod contracts, current Gemini structured-output support, and deterministic validation. Split intent extraction, candidate selection, and user-facing rendering. [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).

Create these contracts, with strict enums, bounds, null/unknown states, units, and ISO timestamps containing timezone offsets:

| Contract | Essential fields / ownership |
|---|---|
| `TripIntent` | Origin/destination queries, schedule, driving/visit limits, desired kinds, confirmed constraints, vehicle assumptions, and `missingFields`. Gemini extracts requests; humans confirm ambiguities. |
| `ResolvedLocation` | Stable internal ID, provider place ID, canonical name, coordinates, source reference, fetched time. Provider resolution owns factual location fields. |
| `GroundedPlace` | Candidate ID, resolved location reference, kind, permitted image/reference, sourced facts, nullable scoped price estimate, projected opening status, compatibility/access status, and eligible/ineligible/unverified status. |
| `RouteLeg` / `RouteAlternative` | Provider route reference/geometry, distance meters, duration seconds, projected arrival, optional sourced eco metric, and freshness/status. |
| `StructuredPlan` | Trip/version, ordered supplied candidate IDs, concise matching reasons, unresolved questions. Gemini may rank/select only IDs passed in its candidate list. |
| `Ballot` / `Vote` | Candidate IDs, participant IDs, plan version, Like/Pass/Must-have/abstain state, event ID, and timestamp. No unvalidated prose choices. |
| `CostEnergyEstimate` | Scope, currency, assumptions, miles, MPG or Wh/mile, fuel/charging price basis, gallons/kWh estimate, comparison baseline, and unknowns. |
| `FeasibilityResult` | Explicit failed/passed/unverified checks and combined-route timing. Computed in code, not asserted by an LLM. |
| `ItineraryVersion` | Confirmed stop order, decision references, approval sender/version, and status; provider facts are refreshed within applicable retention rules. |

Reject unknown IDs, malformed coordinates/times, invalid bounds, extra fields where appropriate, and hallucinated route geometry. Permit one bounded structured-output repair attempt, then show a clarification/retry. Do not scrape an itinerary out of Gemini's prose. Facts without evidence stay unknown; model confidence never certifies them.

Pipeline:

1. Spectrum message/attachment -> Gemini structured intent/inspiration extraction.
2. Confirm ambiguous locations and missing hard constraints.
3. Compute a real baseline route.
4. Query Snowflake for semantically relevant, source-backed corridor knowledge and use Places to resolve/freshen candidate facts. Route-biased Places discovery can extend the curated set.
5. Check preliminary eligibility and actual detour/arrival facts; cap the candidate set.
6. Gemini produces a schema-valid `StructuredPlan` referencing only allowed IDs.
7. Run the optional Decisions API stage when enabled, then deterministic validation regardless of the flag.
8. Publish eligible options; collect versioned preferences/votes.
9. Recompute the combined selected route, including all driving, visits, parking/walking, charging dwell, and buffers.
10. Request final version-specific approval; publish/update the live trip.

Search along a route biases discovery, not proof of detour feasibility. "Open now" does not prove "open at arrival." Unknown cost/accessibility/charger facts cannot silently satisfy a hard requirement. A no-feasible-plan result should offer a specific relaxation for humans to decide. [Route-biased search](https://developers.google.com/maps/documentation/places/web-service/search-along-route).

### Decisions API: optional, post-Gemini, disabled by default

Add one canonical flag, `ENABLE_DECISIONS_API=false`, configurable on/off without changing application logic. Keep a provider-neutral `DecisionEngine.evaluate(ValidatedDecisionInput): Promise<DecisionResult>` adapter with the same output contract on both paths.

The input is the already schema-validated Gemini plan, eligible candidate IDs, permitted preference summaries, route/cost metrics, and constraints. The stage can adjudicate/rank bounded alternatives or request a tradeoff. It cannot invent stops, bypass deterministic constraints, overrule a human vote/approval, or receive raw private conversations.

The current conversation and PDFs do not identify the intended vendor. OpenAI's [Decisions API guide](https://developers.openai.com/api/docs/guides/decisions) is a possible implementation reference, not a confirmed provider selection. Verify the chosen provider, current request/response contract, credential, endpoint, and model before enabling live calls. Do not fabricate an SDK or silently substitute another LLM.

When disabled, skip all Decisions network calls and use deterministic scoring. If enabled but unconfigured, make that status explicit; if it times out/refuses/returns invalid IDs, fall back to local validation/scoring with a visible degraded status in diagnostics. A short timeout must not block the demo. Record whether the stage actually ran, its latency, and the selected mode. Test both paths. This feature is not an additional MLH track.

### Cost, mileage, EV charging, and Frutiger Aero

Optimize within the bounded feasible alternatives: respect schedule and hard constraints first, then compare group preference fit, extra driving, and estimated operating cost/energy. Use deterministic, explainable scoring; do not claim a globally optimal trip.

- Gas estimate: `gallons = routeMiles / confirmedMpg`; fuel cost uses a disclosed price assumption. Separate fuel, meals, paid stops, and uncertain expenses; an estimated total is not a guaranteed charge. Distinguish a soft estimated meal-cost target from a strict spending ceiling: unknown prices cannot certify the latter, so seek a deliberate relaxation or verified alternative rather than quietly approving it.
- EV preset: collect usable battery capacity, initial state of charge, estimated Wh/mile, minimum reserve, connector/network access, and adapter assumptions. Check each leg using a conservative disclosed model; discover compatible charging candidates and include expected charging dwell. Missing compatibility or price remains unverified. Prefer Tesla stops only when compatible/accessible and feasible; a Tesla pin alone is not proof of access or lower electricity use.
- Show estimated kWh using the declared efficiency and route distance, including the chosen conservative margin. Do not claim live battery readings, precise charging curves, or guaranteed arrival charge.
- Estimate charging dwell from a disclosed conservative average charging-rate preset, target charge, and overhead, rather than the station's maximum kW alone. If more than the allowed one charging stop is necessary, return `NO_FEASIBLE_PLAN` and propose changing the assumptions/scope instead of silently expanding the itinerary.
- Compare an efficient option against an explicit feasible baseline serving the same chosen stops and requirements. If an urgent replan drops an activity, describe that tradeoff rather than call it equivalent energy savings.
- Google eco routing excludes intermediate waypoints: use regular multi-stop routing for the itinerary and eco comparisons per fixed leg where supported. Its electric fuel-consumption value is fuel-equivalent, not battery kWh. Keep those metrics distinct. [Google eco routes](https://developers.google.com/maps/documentation/routes/eco-routes).

Frutiger Aero must be present in both the product's behavior and visual craft: blue sky, aqua glass, lush greens, subtle bubbles/reflections, optimistic icons, nature-oriented stops, and transparent fuel/energy comparisons. Maintain readable contrast, large touch targets, reduced-motion support, and fast loading. Avoid generic purple gradients, dense AI paragraphs, gratuitous animation, and environmental claims without a basis. The story may be staged; measurements and API use must be represented honestly.

### Architecture and data ownership

Prefer TypeScript throughout: a long-running Node Spectrum worker, a React/Next.js miniapp, shared schemas/domain services, and PostgreSQL migrations for Tiger Data. Adapt to an existing suitable stack after inspection. Do not assume a short-lived serverless handler can keep the Spectrum connection alive. Avoid extra microservices, Redis, or multiple agent frameworks unless justified by a real need.

Tiger Data is the sole canonical operational store. Model trips, group mappings, members/host, private preference submissions, candidates by permitted identifiers, ballot/votes, immutable plan versions, approvals, inbound event deduplication, and an outbound outbox. Use normal relational tables for transactional state and a hypertable for first-party timestamped trip/decision/refresh events and permitted metrics. Show a useful miniapp history or mileage/cost comparison backed by those events. Restart must preserve user choices and avoid intentionally resending polls/cards. Document delivery semantics honestly rather than promising exactly-once delivery without provider support.

Snowflake owns a separate curated, owned/licensed public corridor corpus: interests/vibes, verified source links, eligible source IDs, stop categories, and curation timestamps. Make a real Cortex Search REST query to retrieve useful inspiration matches. Resolve current Places facts afterward. Do not use Snowflake as a duplicate vote/private-trip database or a decorative no-op integration. Supply small corpus ingestion/setup instructions and an actual integration check. [Cortex Search REST](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-search/query-cortex-search-service), [Tiger hypertables](https://www.tigerdata.com/docs/learn/hypertables/creating-and-configuring-hypertables).

Do not indefinitely store full Google Places responses/photos in either database. Persist permitted IDs and our first-party decisions; follow provider caching, display, and attribution rules. Keep secret API keys server-side, restrict the browser Maps key appropriately, and ensure the miniapp's HTTPS origin can be registered/configured for the actual Photon surface. Never print credentials in logs or planning output.

### State machine and failure behavior

Use `DRAFT -> PLANNING -> VOTING -> VALIDATING -> AWAITING_APPROVAL -> CONFIRMED -> ACTIVE`, with `REPLANNING`, `NEEDS_INPUT`, `NO_FEASIBLE_PLAN`, `TOOLS_UNAVAILABLE`, and `CANCELED` branches. Persist the proposal separately from the confirmed plan.

A deadline, participant, destination, hard constraint, or material price/route change creates a new proposal version. Retain unaffected valid selections; reopen affected decisions. A prior approval/vote does not authorize changed terms. Reject unauthorized host actions and cross-group commands. Process own/outbound messages without feedback loops. Recheck effective participants after membership changes; never erase messages already on friends' phones or promise that capability.

Use bounded retries/timeouts and idempotency keys where supported. If the real provider fails, keep the last approved plan with freshness/status information. Local fixtures are useful for development/rehearsal, but must be visibly labeled; never silently swap them into a live sponsor demo.

### Tracks and evidence

| Target | Actual contribution / evidence |
|---|---|
| Photon - primary | Real Spectrum group/miniapp interaction; humans choose, agent remembers, same dashboard updates after a change. |
| Gemini API | New image or voice/text changes schema-bound preferences/candidates/plan through real Gemini calls. |
| Snowflake API | Real semantic API retrieval from a permitted source-backed corpus affects the candidate set. |
| Tiger Data | Durable votes/versions and timestamped change history; restart demonstrates preserved state. |
| .Tech Domain Name | Miniapp/backend hosted under an actually registered, memorable `.tech` domain. Do not claim an unregistered name is deployed. |
| DEV Writing Challenge | Prepare a truthful build article and demo material matching current official rules, including the required tag/template if applicable; publication is a separate human action. |
| Frutiger Aero Tech | Cohesive glossy/nature UI plus useful mileage/fuel/energy behavior and honest comparisons. |

The hackathon also requires selecting General or Beginner; do not invent the team's Beginner eligibility. Solana is excluded. Nessie is future budgeting work and cannot be claimed as an MVP integration or prize entry.

### Nessie placeholder in `CLAUDE.md`

Keep an explicit future-only section describing a `BudgetProvider`/Nessie adapter boundary for sandbox budgets, expense categorization, and a simulated shared trip fund. For this MVP, only document the interface and, if useful, add a disabled stub returning `not_implemented`. No Nessie credentials, network calls, accounts, transaction flows, budget inference from banking data, or payment UI are required. Plain user-entered trip budgets and estimated costs work independently of Nessie. Future sandbox financial data must not be represented as real banking.

### Demo: approximately three minutes

Before the timer: provision/test the dedicated Photon line and miniapp access, install the Spectrum launcher on three actual phones, configure API keys/domain, and rehearse the chosen corridor. This is setup, not a claim that standard Pro already includes the entitlement.

1. **0:00-0:25:** One teammate sends `/trip` with a confirmed schedule, vehicle assumptions, and an inspiration screenshot. Agent extracts the intent and presents a compact summary.
2. **0:25-1:00:** Three teammates open the card in Messages and submit a few preferences. Use the verified identity path or the disclosed `/confirm` fallback. Show readiness without exposing private raw answers.
3. **1:00-1:45:** Show two grounded options per category; teammates vote. Agent recomputes the full route; host approves its version.
4. **1:45-2:15:** Open the same group's live map: actual route, categorical markers, ETA, miles, and clearly labeled cost/energy estimates.
5. **2:15-3:00:** A teammate sends `/replan arrive 45 minutes earlier`. The agent preserves feasible choices, replaces one incompatible decision if needed, requests approval, and updates that dashboard with a concise explanation.

Tell a simple story about friends wanting an enjoyable outdoor trip without overspending or wasting driving. No judge input or external website is necessary. The memorable result is a live group decision becoming an achievable itinerary, then being repaired across chat and map.

### Build order and acceptance criteria

1. **Capability spike:** Verify actual group receipt/sending, membership events, miniapp rendering/form callbacks/Maps embedding, identity or chat confirmation, card update behavior, and supported OS/device versions. Dedicated cloud group support is a real setup dependency; Free/Pro alone does not establish it. [Photon routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing).
2. **Core slice:** Trip command -> typed intent -> route/place tools -> miniapp options -> real sender-backed vote -> combined validation -> approval -> map. Tiger Data persists it from the beginning.
3. **Distinctive slice:** Add inspiration image, Snowflake retrieval, one replan, gas/EV calculations/charger feasibility, and the Frutiger polish.
4. **Completion:** Optional Decisions adapter/configuration, disabled Nessie placeholder, `.tech` deployment configuration, DEV article draft, integration evidence, and stage runbook.

Perform meaningful checks for fabricated IDs/coordinates, invalid structured output, incorrect units, stale/duplicate votes, cross-trip access, unsupported form identity, raw private-data leakage, unreachable/incompatible chargers, unknown arrival hours, conflicting Must-have requests, combined-route deadline violation, Decisions disabled/error paths, API failure, and restart/outbox recovery. Verify visual layout on actual miniapp-sized screens and actual Messages, not only a desktop browser.

Plan Mode deliverables: concise architecture, phased file/module plan, concrete schemas, exact provider setup checklist, primary/fallback voting policy, state transitions, bounded optimization method, critical-path build order, and the three-minute runbook. Mark tested facts, documented capabilities, and unresolved entitlement/provider questions distinctly. After implementation, provide working code, migrations/seed scripts, `.env.example`, setup/run instructions, meaningful test results, and a truthful live-integration checklist. Do not expand the MVP merely to fit more vendors.

## Prompt 2 - Secondary prompt: complete road-trip context and idea evolution

Use this as design context for Prompt 1. It is an edited history of the AI-enabled travel/road-trip discussion, not a verbatim transcript. It intentionally excludes unrelated concepts. The latest requirements in Prompt 1 and the current `CLAUDE.md` override earlier alternatives in this history.

### 1. What we want to win with

From the beginning of the travel direction, we wanted a powerful "show, don't tell" demonstration rather than another general chatbot. The product must feel useful and fun enough that friends want to keep using it. Photon is the primary sponsor target, with real collaboration, context that survives interactions, restraint about demanding attention, and fallbacks that earn trust. The central proof is an agent participating in a real shared activity while humans make meaningful decisions.

### 2. Inspiration became the starting point

We explored unconventional multimodal travel ideas: sharing TikTok-style travel reels, food inspiration, photos, or screenshots and turning the feeling into similar attainable places. The point was not a wall of recommendations; it was making everyday life more enjoyable by turning inspiration into an experience.

Names and frames such as Elsewhere, SideQuest, and ReelCrew were brainstorms, not reserved product names. The idea evolved toward friends collecting inspiration in Messages and an agent making it practical. The app should not claim access to private TikTok likes, unavailable clips, or arbitrary social accounts. A shared URL can be tried; screenshots/clips are the reliable multimodal fallback.

> _(Prompt 2 ends here in the pasted copy — later sections were not received.)_
