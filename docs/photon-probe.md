# Photon capability probe

**Question:** can our **Spectrum Pro** project run the product's core loop inside a group chat that a person created? Free and Pro use a **shared pool** of numbers: "Each end user is routed through a number from a shared pool," and that number "may differ across recipients." Photon's docs say a shared line "does not create group chats and does not subscribe to iMessage's group-event stream," and that group creation and membership events "require a dedicated line" (Business plan). They **don't** say whether *messages* from a group a person created reach the agent. This probe answers that.

[Photon routing docs](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing)

The probe uses `spectrum-ts` directly (`apps/server/src/probe/`), not our chat adapter, so the results describe Photon and not our code.

## Run it

1. **Credentials.**
   - Copy `.env.example` to `.env`.
   - Set `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` (app.photon.codes → project Settings).
2. **Register the three consenting teammates as project users.** Shared lines only message registered users; anyone else gets "Target not allowed."
   - Use the dashboard, or the Photon CLI with `PHOTON_PROJECT_ID` set:
     ```sh
     photon spectrum users add         # once per teammate
     photon spectrum users ls
     photon spectrum lines ls          # record which line(s) the project has
     ```
   - The CLI install command isn't verified here; see https://photon.codes/docs/cli.
3. **Public HTTPS for app cards.**
   - Run `ngrok http 8787`.
   - Set `PUBLIC_BASE_URL=https://<your-subdomain>.ngrok-free.app` in `.env` (no trailing slash).
4. **Launcher.** Each iPhone installs the Spectrum iMessage App launcher once: https://apps.apple.com/app/id6777616651
5. **Start the probe.** The `--hello` flag DMs each teammate so they learn the agent's number.
   ```sh
   npm run probe -- --hello +19195550101,+19195550102,+19195550103
   ```
   - Every event goes to `probe-logs/probe-<timestamp>.jsonl` (gitignored). Senders are logged only as `sha256-prefix…last4` tags.
   - To check the page without Photon: `npm run probe -- --http-only`, then open `http://localhost:8787/probe`.
6. **Optional map test.** Set `GOOGLE_MAPS_BROWSER_KEY` (plus `GOOGLE_MAP_ID`) to get a "Load map" button on the probe page.

### Commands the probe answers (in any DM or group)

| Text | Checks |
|---|---|
| `/ping` | Replies with chat type, chat hash, your sender tag, the routing line, and inbound lag |
| `/members` | `space.getMembers()` |
| `/card` | Sends a live app card that opens `/probe` |
| `/edit` | Updates that card in place |
| `/poll` | Sends a native poll (vote, then change your vote) |
| `/votes` | Lists the poll events the bot received in this chat |
| `/confirm CODE` | Matches the code shown on the opened card page to the real chat sender |
| `/typing`, `/react` | Typing indicator and tapback |
| photo or voice memo | Replies with mime type and size, and says whether it came as `voice` or `attachment` |

It ignores every other message.

## Test matrix

Fill in **Result** (Pass / Fail / Partial) and **Notes**: what you saw on the phones, plus the matching `event` lines from the log.

| # | Check | Result | Notes |
|---|---|---|---|
| A1 | Spectrum connects (`spectrum_connected` in the log) | | |
| A2 | All 3 teammates registered as project users | | |
| A3 | `photon spectrum lines ls` output recorded (line count and type) | | |
| A4 | Launcher installed on all 3 iPhones | | |
| B1 | `--hello` DM reaches each teammate (`outreach_sent` / `outreach_failed`) | | |
| B2 | `/ping` in each DM round-trips | | |
| B3 | **Every teammate sees the same agent number** (if not, note each one) | | |
| C1 | A teammate creates a new group with the other two plus the agent's number | | |
| C2 | **The bot receives `/ping` from all 3 members** (`inbound` with `space.type: "group"`) | | |
| C3 | Each member gets a **distinct** sender tag | | |
| C4 | Replies land **in the group**, not in DMs | | |
| C5 | If B3 showed different numbers: repeat C1–C4 with each number | | |
| D1 | Photo in the group: received and read (`attachment_read`) | | |
| D2 | Voice memo in the group: arrives as `voice` or `attachment` (note the mime type) | | |
| D3 | `/card` renders as a **live** card (or note if it shows as a static link preview) | | |
| D4 | Tapping the card opens `/probe` inside Messages; the page says "Server reached" | | |
| D5 | Beacon headers or query show any Photon identity or group context (`probe_beacon`) | | |
| D6 | `/confirm CODE` from the page → "Code matched … Card came from this chat: yes" | | |
| D7 | `/edit` updates the **same** card bubble | | |
| D8 | `/poll` arrives; votes and vote changes show in `/votes` with the right sender tags | | |
| D9 | `/members` lists the other members | | |
| D10 | Add or remove a member: does any event arrive? (Expected **no** on Pro) | | |
| D11 | Optional: "Load map" renders tiles and a marker inside Messages | | |
| E1 | Typical inbound lag (from `/ping`) and the time from send to reply on the phone | | |
| E2 | iOS version on each phone (from the beacon user agent) | | |

## Go / no-go

- **Go:** C2–C4 pass, **and** D4 and D6 pass (a card opens our page, and `/confirm` ties it to the real sender in the same group).
  - Polls (D8) are nice to have, because `/vote` is the text fallback.
  - If D3 shows only a static link preview but D4 still opens the page, treat that as a partial pass and note it.
- **No-go:** the bot doesn't receive messages from all members of a group someone created, or can't reply into it.
  - Take the log to Photon (booth or help@photon.codes) and ask about a dedicated Business line.
  - Moving forward is the owner's decision.

## Results

### 2026-10-10, first runs (owner + 2 teammates, Pro plan, shared-pool line)

- **A1 Pass:** `spectrum_connected`. The SDK reports the line as `phone: "shared"`.
- **A2 Pass:** 3 users are registered and active in Spectrum → Users.
- **B3 Fail (by design on Pro):** the dashboard's "Texts on" column gives **each user a different agent number** (…1364, …1532, …7704). No single number exists to add to a group.
- **B1 Partial:**
  - The `--hello` DM reached the owner.
  - The teammate ending …4108 got `AuthenticationError: Target not allowed for this project`. This happened even though he's registered, and even *after* he had texted the agent.
  - The chat id the SDK built (`any;-;<E.164>`) is the same one his inbound message used, so it isn't a formatting problem.
- **Inbound DMs from both teammates arrived**, each on their own line, with `lagMs` of 3–6 s. They weren't commands (no `/`), so the probe didn't reply. Since then the probe hints in DMs.
- **B1 Pass on retry (19:28):** `--hello` reached all 3 (`outreach_sent` ×3). The earlier `Target not allowed` went away without any change on our side. A short activation delay after registering a user is likely but unconfirmed.
- **Read receipts arrive:** inbound events with ids ending `:read:<n>` came from both teammates.
- **C2 Fail (group via the owner's line …1364, probe running since 19:37:27):** all 3 members sent `/ping` in a new group that included …1364.
  - **No inbound event of any kind reached the probe**, not even as a DM, and no reply was sent.
  - Earlier `/ping`s, sent while no probe was running (19:28:56–19:37:27), were also never delivered (no catch-up on start).
  - **Conclusion so far: on Pro, the shared-pool line does not deliver group-chat messages to the project. This is a no-go for "the agent lives in the existing GC" without a dedicated line.**

### 2026-10-10 20:17: native poll in the owner's DM (Pro)

- **D8 Fail (votes):**
  - `/poll` sent and rendered as a native iMessage poll, and the owner's tap on "BBQ lunch" registered on the phone.
  - **No `poll_option` event, or any other event, reached the probe.** We checked for 90+ s after the tap.
  - The SDK does subscribe to the `poll.changed` stream, and shared mode doesn't filter it out, so Photon doesn't appear to deliver poll votes on the shared pool.
  - Pending: check the probe terminal for `skipping unmappable imessage event` warnings.
- **Consequence:** don't use native polls as ballots on Pro. People would vote and it wouldn't count. Use the miniapp card or text `/vote` instead.

### 2026-10-10 20:20: live app card in the owner's DM (Pro)

- **D3 Pass:** `/card` returned a `miniAppCardSession`, so it's a live card, not a link preview.
- **D4 Pass:** the page opened **inside Messages**. Its user agent includes `Spectrum/1.3.3 (Build 36)` (the Spectrum launcher) on iOS 26.6.2, and the beacon reached the server.
- **D5 (no identity bridge):** the request headers carried no Photon identity or group context. The cookie was redacted; it's likely ngrok's.
- **D6 Pass:** `/confirm JSDVBF` matched the page session to the verified sender, and "Card came from this chat: yes".
- **D7 Pass:** `/edit` updated the same bubble. The page reloaded with `rev=2` right away, inside the bubble.
- **Viewports seen:** 280×300 and **163×57** (the in-bubble live view). The trip card needs a tiny "status" layout as well as a fuller one.
- **Tapback:** no `reaction` event was logged, either because none was sent or because reactions aren't delivered. Unconfirmed.

### Decision (2026-10-10)

Go with the **per-person DM design**:
- Each traveler talks to the agent in their own thread.
- Shared trip state lives in Tiger Data.
- Live cards in each thread are the ballot and the map entry point.
- Group chat and native-poll ballots are out on Pro.

### 2026-10-10: local Mac provider (`@spectrum-ts/imessage-local`) check

- **It exists:** it's in `photon-hq/spectrum-ts/packages/imessage-local`, published on npm as v12.10.1. It runs on a Mac and reads and sends through that Mac's own Messages app, using `@photon-ai/imessage-kit` (reads `chat.db`, sends via AppleScript).
- **What it supports:**
  - Inbound DMs and groups.
  - Sending text and attachments into an **existing** group via `space.get(chatGuid)`. It can't create groups.
- **What it doesn't support** (from its source):
  - `app` cards are sent as a plain URL, and custom mini-app cards aren't available.
  - No edits, polls, effects, reactions, threaded `reply`, `getMembers`, or read receipts. Typing indicators are silently ignored.
- **Requirements:**
  - macOS, with Messages.app running and signed in.
  - **Full Disk Access** for the terminal that runs Node.
  - Node ≥20 plus `better-sqlite3`; npm 11 needs `npm approve-scripts better-sqlite3`.
- **On the dev Mac:**
  - The install, native build, and provider load all work.
  - Starting it failed with `unable to open database file` because the terminal had no Full Disk Access.
  - No messages were read.
- **Caveat:** it acts as whatever Apple ID is signed into that Mac's Messages, and it can read that account's entire message history. Use a **dedicated agent Apple ID** (Mac mini or a separate macOS user), never a teammate's personal account.
