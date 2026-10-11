# Acquired features

This file carries forward the two capabilities we built and tested on 2026-10-10. Everything else from that session is out of scope.

1. **Photon setup:** connecting an agent to iMessage through Photon Spectrum and getting it working.
2. **Message capture:** saving every message's content and metadata from a user ↔ agent private iMessage chat, live into Tiger Data and as a full-history backfill.

Open UX concerns for the mini-app dashboard are listed at the end, under **Concerns to keep in mind and address**.

Each claim is marked with how sure we are:
- ✅ **Verified:** run on real phones, Photon, or an actual database during the session.
- 🧪 **Tested locally:** unit and integration tests passed, but it hasn't run against the real service yet.
- 📄 **Documented:** taken from Photon's docs or SDK source and not exercised.
- ⚠️ **Caveat:** a known limitation or risk.

Environment used: macOS, Node 24.18, npm 11.16, `spectrum-ts` 12.10.1, TypeScript 6.0.3, iPhones on iOS 26.

---

## Feature 1: Photon (Spectrum) setup

### 1.1 What you're working with

- **Photon Spectrum** is an agent SDK. iMessage is reached through Photon's cloud ("managed iMessage infrastructure") over gRPC.
  - The npm package is **`spectrum-ts`**. It bundles `@spectrum-ts/core` and `@spectrum-ts/imessage`, and depends on Photon's lower-level client `@photon-ai/advanced-imessage` (2.2.0).
- **Incoming messages arrive on a long-lived stream** (`spectrum.messages`). Run the agent as a persistent Node process, never serverless or edge.
- **Our plan is Spectrum Pro, which uses a shared pool of numbers.** ✅ **Each registered user texts a different agent number**, shown in the dashboard's "Texts on" column. There is no single bot number.

What works on Pro (all ✅ verified 2026-10-10):

| Capability | Result |
|---|---|
| User → agent DM, agent replies | ✅ ~1–6 s inbound lag |
| Agent texts a registered user **first** | ✅ (`im.space.create` + `send`) |
| Live **app card** (mini-app) in a DM | ✅ opens inside Messages via the Spectrum launcher |
| Update a sent card **in place** (`edit`) | ✅ same bubble re-renders with the new URL |
| Tie a card page session to the real sender (`/confirm CODE`) | ✅ |
| Read receipts arrive as events | ✅ (`content.type === "read"`) |
| Full DM history via `messages.listInChat` | ✅ (see 2.6) |
| **Group chats** (human-created group + agent number) | ❌ zero events reach the agent |
| **Native iMessage poll votes** | ❌ the poll renders, but votes never arrive |
| `messages.listRecent` (history across all chats) | ❌ `No instance routed for this request` |

Group chats need a **dedicated line** (Business plan). 📄 Photon's docs say "Group creation and inbound group-change events require a dedicated line."

### 1.2 One-time account setup

1. **Project:** create one at **app.photon.codes**. Under project **Settings**, copy the **Project ID** and **Project Secret**.
2. **Register every person the agent will talk to** (Pro allows 100). A shared-pool line only messages registered users; anyone else gets `AuthenticationError: Target not allowed for this project`.
   - Use the dashboard (**Spectrum → Users → Add user**) or the CLI with `PHOTON_PROJECT_ID` set:
     ```sh
     photon spectrum users add
     photon spectrum users ls
     photon spectrum lines ls
     ```
   - 📄 The CLI install command wasn't verified; see https://photon.codes/docs/cli
   - ⚠️ Right after registering, sends to that user can fail with `Target not allowed` for a few minutes. ✅ We saw this, and it cleared up without any change on our side.
3. **The "Texts on" column is that user's personal agent number.** Have each person save it as a contact (e.g. "Trip Agent") so iOS doesn't file it under Unknown Senders.
4. **Live app cards:** each iPhone installs the **Spectrum iMessage App** launcher once: https://apps.apple.com/app/id6777616651
5. **Public HTTPS for card pages:** run `ngrok http 8787` and set `PUBLIC_BASE_URL` to the https URL.

### 1.3 Project setup

```sh
nvm use 24
npm install spectrum-ts@12.10.1 hono @hono/node-server zod
npm install -D typescript@^6 tsx @types/node
```

- ⚠️ **Pin TypeScript to 6.x.** spectrum-ts declares the peer range `typescript ^5 || ^6`. With TS 7, npm installs a second, nested TypeScript.
- ⚠️ **npm 11 warnings:** you'll see `allow-scripts` warnings for `esbuild` and `protobufjs`. ✅ `tsx` and Spectrum worked without approving them.
- Run TypeScript directly: `tsx --env-file-if-exists=.env src/agent.ts`.

`.env` (gitignored):

```sh
SPECTRUM_PROJECT_ID=...
SPECTRUM_PROJECT_SECRET=...
PORT=8787
PUBLIC_BASE_URL=https://<subdomain>.ngrok-free.dev   # no trailing slash; only needed for app cards
```

### 1.4 Minimal working agent

Every call below is verified against the SDK's type definitions and was exercised on real phones.

```ts
// src/agent.ts
import { app as appCard, type ContentInput, edit, Emoji, type Message, type Space, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const spectrum = await Spectrum({
  projectId: process.env.SPECTRUM_PROJECT_ID as string,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET as string,
  providers: [imessage.config()],
  telemetry: false, // otherwise the SDK sends traces to Photon's endpoint
});
// Bad credentials → SpectrumCloudError (422 VALIDATION_ERROR). Catch it and exit with a clear message.
const im = imessage(spectrum);

// --- Text a registered user first (phone in E.164) ---
const dm = await im.space.create(await im.user("+15555550101"));
await dm.send("Hi! Reply /ping");
// On a shared-pool line, space.create makes no network call: it builds the DM id `any;-;<E.164>` locally.
// The send is what Photon authorizes (and where "Target not allowed" surfaces).

// --- Receive ---
const seen = new Set<string>();
const cards = new Map<string, Message>(); // space.id → last card, for in-place edits

for await (const [space, message] of spectrum.messages) {
  if (seen.has(message.id)) continue; // delivery is at-least-once
  seen.add(message.id);
  if (message.direction === "outbound") continue; // never react to our own messages
  handle(space, message).catch((err) => console.error("handler error", err));
}

async function handle(space: Space, message: Message) {
  const c = message.content;

  if (c.type === "attachment" || c.type === "voice") {
    const bytes = await c.read(); // each read() re-downloads, so read once
    await message.reply(`Got ${c.mimeType}, ${Math.round(bytes.length / 1024)} KB`);
    return;
  }
  if (c.type !== "text") return;

  const [command, ...args] = c.text.trim().split(/\s+/);
  switch (command?.toLowerCase()) {
    case "/ping":
      await message.reply("pong");
      return;
    case "/card": {
      // Live mini-app card; the layout is built from the page's Open Graph tags (og:title, og:description).
      const sent = await space.send(appCard(`${process.env.PUBLIC_BASE_URL}/page?n=${Date.now()}`, { live: true }));
      if (sent) cards.set(space.id, sent); // the returned message carries `miniAppCardSession`
      return;
    }
    case "/edit": {
      const card = cards.get(space.id);
      if (card) await space.send(edit(appCard(`${process.env.PUBLIC_BASE_URL}/page?rev=2`, { live: true }), card));
      return;
    }
    case "/typing":
      await space.responding(() => new Promise((r) => setTimeout(r, 2500))); // shows the typing bubble
      return;
    case "/react":
      await message.react(Emoji.like); // native tapback
      return;
  }
}
```

**Useful message and space fields (✅ observed):**
- `message.id` looks like `spc-msg-<uuid>`. Read receipts look like `…:read:<n>`.
- `message.sender.id` is the user's E.164 number.
- `message.timestamp` is a `Date`.
- `space.id` is `any;-;+1XXXXXXXXXX` for a DM.
- `space.type` is `"dm"` or `"group"`. On Pro, `space.phone` is the literal string `"shared"`.

### 1.5 Identity for card pages (the `/confirm CODE` pattern)

✅ The card page receives **no identity**: no Photon headers, tokens or user info. To attribute an action on the page to a real person:

1. When the page opens, it POSTs to your server (`/api/beacon`).
2. The server mints a random code and shows it on the page.
   - Use **6 characters** from the alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, so there are no lookalike characters.
   - Make it **one-use** and expire it after **10 minutes**.
   - Rate-limit the endpoint (we used 30 requests per minute per IP).
3. The user texts **`/confirm CODE`** to the agent.
4. The server consumes the code and binds that page session to `message.sender.id`. It can also check that the card came from the same chat, by putting a hash of `space.id` in the card URL.

✅ This was verified: `/confirm JSDVBF` matched, with "Card came from this chat: yes". Never return private data from a lookup by code.

**Card page facts (✅ observed):**
- The user agent contains `Spectrum/1.3.3 (Build 36)` (on iOS 26.6.2).
- Viewports were **163×57** inside the bubble and **280×300** when expanded. Design a tiny status view.
- After `edit`, the page reloads inside the bubble with the new URL.

### 1.6 Verification checklist

| Step | Expected |
|---|---|
| Start the agent | Logs "Spectrum started" (or your own connected log) |
| Text the agent `/ping` from a registered phone | "pong" within a few seconds |
| Agent texts a newly registered user first | Delivered. If `Target not allowed`, wait a few minutes and retry |
| `/card`, then tap it | Opens inside Messages; your server sees the page request |
| `/edit` | The same bubble updates |
| Photo or voice memo | `attachment` (image/*) or `voice`/`attachment` (audio/*) |

### 1.7 Gotchas

- ✅ **At-least-once delivery.** Always dedupe on `message.id`.
- ✅ **The agent's own sends don't come back on the stream.** No outbound echoes were seen, so record outbound messages when you send them.
- ✅ **A fresh start doesn't replay messages sent while the agent was down.** Use history (2.6) if you need them.
- ✅ **Phone formatting:** pass E.164 (`+15555550101`). A pasted `+1 (555) …` gets split by the shell. Normalize by stripping everything except digits and `+`.
- 📄 **Voice memos** may arrive as `voice` content or as an `attachment` with an `audio/*` type. Handle both. iMessage `.caf` needs transcoding before most models can read it.
- 📄 **Webhooks** (`spectrum.webhook(req, handler)`) don't deliver poll votes, edits, typing or read receipts. Use the stream.
- ✅ **Don't use native polls as ballots on Pro.** Votes never arrive. Use a card or text replies instead.
- ✅ **Group chats on Pro deliver nothing.** Options:
  - Photon Business, with a dedicated line.
  - Photon's **local Mac provider** `@spectrum-ts/imessage-local` (12.10.1).
    - 📄 It reads and sends through a Mac's Messages app, and supports existing groups.
    - Requirements: Full Disk Access for the terminal, Messages signed in, `better-sqlite3` (npm 11 needs `npm approve-scripts better-sqlite3`), and a **dedicated Apple ID**.
    - ⚠️ It sends app cards as plain links, and has no edits, polls, reactions, replies or member lists.
- ⚠️ **Privacy:** Photon's infrastructure decrypts iMessages on its side, so it sees content. Its privacy policy doesn't state retention for message content. Say "private from your friends," never "end-to-end private."

---

## Feature 2: Extract and save all message content and metadata (user ↔ agent DM)

### 2.1 Approach

Two paths write into one Tiger Data table:

| Path | Captures | Status |
|---|---|---|
| **Live:** every event on `spectrum.messages`, plus every agent send recorded at send time | Everything from the moment the agent runs | 🧪 code and tests pass on PGlite. Not yet run against real Tiger Data (no `DATABASE_URL` during the session) |
| **History backfill:** `messages.listInChat(chatId)` on Photon's lower-level client | Everything earlier in the DM | ✅ verified against Photon: 19/19 messages exported in order. 🧪 the backfill → Tiger mapping in 2.7 isn't built yet |

✅ **The IDs match across both paths.** For example, `spc-msg-f0e789e3-c895-4e3b-888e-95f6dbb0ea90` appeared in both the live stream and the history export. So backfill and live rows share one table, deduplicated on `event_id`.

### 2.2 Tiger Data setup

1. Create a service at **tigerdata.com** (managed Postgres with TimescaleDB; there's a free tier).
2. Copy the connection string into `.env` as `DATABASE_URL=postgres://…`.
   - ⚠️ The copied string can leave out the password, so make sure it's in there.
   - SSL is required, and the client sets `ssl: "require"`.
3. Install the dependencies:
   ```sh
   npm install drizzle-orm postgres
   npm install -D drizzle-kit @electric-sql/pglite   # pglite = in-process Postgres for tests
   ```

### 2.3 Table: `chat_events` (a TimescaleDB hypertable)

```ts
// src/db/schema.ts
import { index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const chatEvents = pgTable(
  "chat_events",
  {
    eventId: text("event_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    chatId: text("chat_id").notNull(),
    chatType: text("chat_type").notNull(),            // dm | group | unknown
    platform: text("platform").notNull(),             // imessage
    direction: text("direction").notNull(),           // inbound | outbound
    senderHandle: text("sender_handle"),              // E.164 of the human; null for the agent
    kind: text("kind").notNull(),                     // text, attachment, voice, reaction, read, poll, poll_option, app, …
    text: text("text"),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),   // type-specific details, never bytes
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(), // provider metadata as delivered
    source: text("source").notNull(),                 // stream | send  (add "backfill" for 2.7)
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Hypertable unique keys must include the time column → composite PK.
    primaryKey({ columns: [t.eventId, t.occurredAt] }),
    index("chat_events_chat_time_idx").on(t.chatId, t.occurredAt.desc()),
  ],
);
```

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
```

Generate the migrations (works offline):

```sh
npx drizzle-kit generate --name=chat_events
npx drizzle-kit generate --custom --name=chat_events_hypertable   # then paste the SQL below into it
```

`drizzle/0000_chat_events.sql` (generated):

```sql
CREATE TABLE "chat_events" (
	"event_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"chat_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"platform" text NOT NULL,
	"direction" text NOT NULL,
	"sender_handle" text,
	"kind" text NOT NULL,
	"text" text,
	"content" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"source" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_events_event_id_occurred_at_pk" PRIMARY KEY("event_id","occurred_at")
);
--> statement-breakpoint
CREATE INDEX "chat_events_chat_time_idx" ON "chat_events" USING btree ("chat_id","occurred_at" DESC NULLS LAST);
```

`drizzle/0001_chat_events_hypertable.sql` (custom). It's guarded so the same migrations run on plain Postgres and PGlite in tests:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable('chat_events', by_range('occurred_at'), if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END
$$;
```

⚠️ The hypertable step has only run in its no-op form (PGlite). Its first real run is `migrate` against Tiger Data. `by_range` needs TimescaleDB ≥ 2.13.

Database client and migrate script:

```ts
// src/db/client.ts
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>; // postgres-js in prod, PGlite in tests
export const MIGRATIONS_DIR = new URL("../../drizzle/", import.meta.url);

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { ssl: "require", max: 5 });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}
```

```ts
// src/db/migrate.ts  →  tsx --env-file-if-exists=.env src/db/migrate.ts
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, MIGRATIONS_DIR } from "./client";

const { db, close } = createDb(process.env.DATABASE_URL as string);
await migrate(db, { migrationsFolder: fileURLToPath(MIGRATIONS_DIR) });
await close();
```

### 2.4 Mapping a Spectrum message to a row

The generic metadata copy means new provider fields get stored without code changes.

```ts
// src/chat/spectrum-adapter.ts
import type { Message, Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { ChatEvent } from "../ingest/chat-events";

const CORE_KEYS = new Set(["id", "content", "direction", "platform", "sender", "space", "timestamp"]);

export async function toChatEvent(space: Space, message: Message, source: ChatEvent["source"]): Promise<ChatEvent> {
  const { text, content } = await describeContent(message.content);
  return {
    eventId: message.id,
    occurredAt: message.timestamp instanceof Date ? message.timestamp : new Date(),
    chatId: space.id,
    chatType: imessage.is(space) ? space.type : "unknown",
    platform: message.platform,
    direction: message.direction,
    senderHandle: message.direction === "inbound" ? (message.sender?.id ?? null) : null,
    kind: message.content.type,
    text: text === null ? null : clean(text),
    content,
    metadata: providerMetadata(message),
    source,
  };
}

async function describeContent(c: Message["content"]): Promise<{ text: string | null; content: Record<string, unknown> }> {
  switch (c.type) {
    case "text":        return { text: c.text, content: {} };
    case "markdown":    return { text: c.markdown, content: { format: "markdown" } };
    case "attachment":  return { text: null, content: { attachmentId: c.id, name: c.name, mimeType: c.mimeType, size: c.size ?? null } };
    case "voice":       return { text: null, content: { mimeType: c.mimeType, durationSeconds: c.duration ?? null, size: c.size ?? null } };
    case "poll":        return { text: c.title, content: { options: c.options.map((o) => o.title) } };
    case "poll_option": return { text: c.option.title, content: { poll: c.poll.title, selected: c.selected } };
    case "reaction":    return { text: c.emoji, content: { targetId: c.target?.id ?? null } };
    case "read":        return { text: null, content: { targetId: c.target?.id ?? null } };
    case "reply": {
      const inner = await describeContent(c.content as Message["content"]);
      return { text: inner.text, content: { ...inner.content, replyToId: c.target?.id ?? null } };
    }
    case "app": {
      const url = await c.url().catch(() => null);
      return { text: null, content: { url, live: c.live ?? false } };
    }
    default:            return { text: null, content: { fields: Object.keys(c) } };
  }
}

function providerMetadata(message: Message): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    if (CORE_KEYS.has(key) || value === undefined || typeof value === "function") continue;
    out[key] = jsonSafe(value, 0);
  }
  return out;
}

// Dates → ISO, bytes → size, functions dropped, depth/length bounded. Postgres rejects \u0000 in text/jsonb.
function jsonSafe(value: unknown, depth: number): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return clean(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (depth >= 4) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => jsonSafe(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && typeof v !== "function").map(([k, v]) => [k, jsonSafe(v, depth + 1)]),
  );
}

const clean = (s: string) => s.replaceAll("\u0000", "");
```

**What lands in `metadata` for iMessage** (✅ these field names were observed on live messages): `dateDelivered`, `dateEdited`, `dateExpressiveSendPlayed`, `datePlayed`, `dateRead`, `dateRetracted`, `isSent`, `isDelivered`, `isDeliveredQuietly`, `didNotifyRecipient`, `isDelayed`, `sendErrorCode`, `nativeText`, `partIndex`, `parentId`. Cards also carry `miniAppCardSession`.

### 2.5 The sink and the wiring

```ts
// src/ingest/chat-events.ts
import type { Db } from "../db/client";
import { chatEvents } from "../db/schema";

export interface ChatEvent {
  eventId: string; occurredAt: Date; chatId: string; chatType: "dm" | "group" | "unknown";
  platform: string; direction: "inbound" | "outbound"; senderHandle: string | null; kind: string;
  text: string | null; content: Record<string, unknown>; metadata: Record<string, unknown>;
  source: "stream" | "send";
}

export function createChatEventSink(db: Db, onError: (event: ChatEvent, error: unknown) => void) {
  return {
    async record(event: ChatEvent) {
      try {
        await db.insert(chatEvents).values(event).onConflictDoNothing(); // idempotent: at-least-once delivery
      } catch (error) {
        onError(event, error); // a database hiccup must never take the chat loop down
      }
    },
  };
}
```

Wiring it into the agent from 1.4:

```ts
const tiger = process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL) : null;
const sink = tiger ? createChatEventSink(tiger.db, (e, err) => console.error("tiger write failed", e.eventId, err)) : null;

function recordEvent(space: Space, message: Message, source: "stream" | "send") {
  if (!sink) return;
  toChatEvent(space, message, source).then((e) => sink.record(e)).catch((err) => console.error("map failed", err));
}

// 1) Every stream event (messages, reactions, read receipts…), right after dedupe and before any filtering:
for await (const [space, message] of spectrum.messages) {
  if (seen.has(message.id)) continue;
  seen.add(message.id);
  recordEvent(space, message, "stream");
  if (message.direction === "outbound") continue;
  // …handle…
}

// 2) Every agent send. Outbound messages are NOT echoed on the stream, so wrap the send paths:
async function send(space: Space, content: ContentInput) {
  const sent = await space.send(content);
  if (sent) recordEvent(space, sent, "send");
  return sent;
}
async function reply(message: Message, content: ContentInput) {
  const sent = await message.reply(content);
  if (sent) recordEvent(message.space, sent, "send");
  return sent;
}
// Use send()/reply() everywhere instead of space.send()/message.reply().
// Note: send(edit(...)) resolves undefined (no new id), so card edits aren't recorded by this path.

// 3) On shutdown:
await tiger?.close();
```

**Checking the stored rows** (the session's `db:tail` script, abridged): select the latest rows and write them to a `.txt`.

```ts
const rows = (await db.select().from(chatEvents).orderBy(desc(chatEvents.occurredAt)).limit(50)).reverse();
// format: occurred_at | in/out | kind | source | …chatId last4 | event_id | text or JSON(content)
```

### 2.6 History backfill (everything before streaming started)

spectrum-ts has **no public history API**. ✅ Photon's lower-level client has one: `messages.listInChat(chat, { after?, before?, pageSize: 1..100, pageToken? })`, which returns `{ messages, nextPageToken? }`. Reach it through Spectrum's internal registry:

```ts
type InternalSpectrum = { __internal: { platforms: Map<string, { client: unknown }> } };
interface HistoryClient {
  messages: {
    listInChat(chat: string, o?: { pageSize?: number; pageToken?: string; after?: Date; before?: Date }):
      Promise<{ messages: readonly HistoryMessage[]; nextPageToken?: string }>;
  };
}
interface HistoryMessage {
  guid: string;                 // same id as the live stream's message.id
  dateCreated: Date;
  isFromMe: boolean;            // true = agent
  itemType: string;             // "normal" | "groupNameChange" | "participantChange" | "chatAction" | "unknown"
  isAudioMessage: boolean;
  sender?: { address: string; service: string };
  content: {
    text?: string;
    balloonBundleId?: string;   // polls / app cards / card updates
    attachments: readonly { fileName: string; mimeType: string; totalBytes: number }[];
    miniApp?: { url?: string; live: boolean };
  };
  reaction?: { kind: string; emoji?: string };
  reactionTargetGuid?: string;
  replyTargetGuid?: string;
  dateDelivered?: Date; dateRead?: Date; dateEdited?: Date; dateRetracted?: Date;
}

// In shared (Pro) mode the client array has one entry: { phone: "shared", client }.
const entries = (spectrum as unknown as InternalSpectrum).__internal.platforms.get("imessage")?.client as
  { phone: string; client: HistoryClient }[] | undefined;
const history = entries?.[0]?.client;
if (!history) throw new Error("iMessage history client not reachable (SDK internals changed?)");

async function fetchDm(peerE164: string): Promise<HistoryMessage[]> {
  const chat = `any;-;${peerE164}`; // the DM id format Photon routes by
  const all: HistoryMessage[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await history.messages.listInChat(chat, { pageSize: 100, ...(pageToken && { pageToken }) });
    all.push(...page.messages);
    pageToken = page.nextPageToken;
  } while (pageToken && ++pages < 200);
  return all.sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime() || a.guid.localeCompare(b.guid));
}
```

✅ **Verified result:** the owner's DM returned 19 messages (first user "Hey!" to the last card update) in one page, in order.

**Balloon types seen:**
- `com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls`: a native poll.
- `com.apple.messages.MSMessageExtensionBalloonPlugin:P8XT6232SL:codes.photon.Spectrum.MessagesExtension`: a Spectrum app card. A card **update** shows up as a *new* balloon message.

**Caveats:**
- ⚠️ `__internal` isn't a public API, so an SDK upgrade can break it. Ask Photon (ryan@photon.codes) whether this use is supported.
- ⚠️ History is per chat: you need each user's `any;-;<E.164>`, the registered users' numbers.
- ⚠️ `listRecent` doesn't work on Pro (`No instance routed`).
- ⚠️ **Votes on native polls aren't messages and don't appear in history.**

### 2.7 Writing backfill into Tiger Data (🧪 not built yet; the mapping to implement)

1. Add `"backfill"` to `ChatEvent["source"]`.
2. Map each `HistoryMessage` to a `ChatEvent` and call `sink.record()`. Because of `onConflictDoNothing`, overlap with live rows is harmless.

```ts
function historyToChatEvent(m: HistoryMessage, chatId: string, peerE164: string): ChatEvent {
  const kind = m.reaction ? "reaction"
    : m.content.miniApp ? "app"
    : m.content.balloonBundleId?.endsWith("com.apple.messages.Polls") ? "poll"
    : m.isAudioMessage ? "voice"
    : m.content.attachments.length ? "attachment"
    : "text";
  return {
    eventId: m.guid,
    occurredAt: m.dateCreated,
    chatId,
    chatType: chatId.includes(";+;") ? "group" : "dm",
    platform: "imessage",
    direction: m.isFromMe ? "outbound" : "inbound",
    senderHandle: m.isFromMe ? null : (m.sender?.address ?? peerE164),
    kind,
    text: m.reaction ? (m.reaction.emoji ?? m.reaction.kind) : (m.content.text ?? null),
    content: {
      attachments: m.content.attachments.map((a) => ({ name: a.fileName, mimeType: a.mimeType, size: a.totalBytes })),
      balloonBundleId: m.content.balloonBundleId ?? null,
      appCardUrl: m.content.miniApp?.url ?? null,
      targetId: m.reactionTargetGuid ?? null,
      replyToId: m.replyTargetGuid ?? null,
    },
    metadata: { itemType: m.itemType, dateDelivered: m.dateDelivered?.toISOString() ?? null,
                dateRead: m.dateRead?.toISOString() ?? null, dateEdited: m.dateEdited?.toISOString() ?? null },
    source: "backfill",
  };
}
```

⚠️ **Watch for:** live rows use `message.timestamp` and backfill rows use `dateCreated` for `occurred_at`. ✅ They matched to the millisecond in our data (`/poll`: 20:17:15.226Z in both). If they ever differ, the composite PK would admit duplicates. In that case, check for an existing `event_id` before inserting.

### 2.8 Tests and checks

**Integration test on PGlite** (✅ passing). It runs the real migrations, records the same event twice, and expects one row. It also checks that a failed write reaches `onError` instead of throwing.

```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
const pg = drizzle(new PGlite(), { schema });
await migrate(pg, { migrationsFolder: fileURLToPath(MIGRATIONS_DIR) });
const db = pg as unknown as Db;
```

**Mapping tests** (✅ passing) cover these cases:
- inbound text with metadata, including stripping `\u0000`
- attachment: metadata only, never `read`/bytes
- outbound app card: `senderHandle: null`, URL resolved
- reaction or read receipt mapped to `targetId`

**Going live** (🧪 the steps to verify next):
1. Set `DATABASE_URL`, then run the migrate script. The hypertable gets created.
2. Start the agent and check for your "sink enabled" log.
3. Exchange a few messages with the agent.
4. Run the tail query. Expect one row per message in both directions, plus `read` rows. Inbound rows have `sender_handle` set; outbound rows have `source = send`.

### 2.9 Privacy rules carried forward

- Exports and tails contain real message text, so keep their output folder (`exports/`) **gitignored**.
- Operational logs must never contain raw phone numbers. Use `sha256(handle).slice(0, 8) + "…" + last4`.
- Raw private messages can inform the agent's private replies to *that* user, but group-level logic should only read shareable data (votes, confirmed constraints, aggregates).
- Consider a retention period, such as dropping raw text after the trip ends.

---

# Concerns to keep in mind and address

## C1. Showing a dashboard inside iMessage (no leaving the app)

**Answer: yes.** A web page can open as a mini app inside a private chat with the agent. ✅ Verified on 2026-10-10:
- The agent sent `app(url, { live: true })`, the user tapped it, and the page loaded **inside Messages** through Photon's Spectrum launcher. The page's user agent included `Spectrum/1.3.3 (Build 36)`.
- JavaScript ran and the page called our server (`fetch`), so a dashboard can load fresh data and refresh while it's open.
- `edit(app(newUrl, { live: true }), sentCard)` reloaded the **same bubble** with the new page. As the conversation changes the trip, the agent updates the dashboard card in place instead of sending new messages.

**Requirements and caveats:**
- **Launcher:** every iPhone installs the Spectrum iMessage App once (https://apps.apple.com/app/id6777616651). 📄 Without it, the card falls back to a plain link preview that opens Safari.
- **Public HTTPS URL:** ngrok during development, a real domain later. The card's caption and image come from the page's Open Graph tags (`og:title`, `og:description`, `og:image`).
- **The space is small.** ✅ Measured viewports were **163×57 points in the bubble** and **280×300 points when opened**. Design a compact summary first (see C2).
- **No viewer identity.** ✅ The page receives no Photon identity, headers or tokens. In a private chat, a card sent only to one person can carry a signed per-person link. Use `/confirm CODE` (Feature 1.5) for anything sensitive.
- ⚠️ **Google Maps inside the card is untested.** Test it before building the map view. The fallback is a static map image on the page.

**Fallbacks without the launcher (or alongside the card):**
1. **Dashboard as an image (best fallback).** The server renders a picture of the dashboard and sends it as a photo, which opens full-screen and zoomable inside Messages. 📄 Sending attachments is supported by the SDK. ⚠️ Untested on Pro. Each update is a new image.
2. **Link preview with an image.** Send the URL with the dashboard image as its `og:image`, so the preview bubble itself is the summary. Tapping it leaves for Safari.
3. **PDF itinerary.** An attachment opens in Messages' built-in viewer. Good for a final printable plan.
4. **One text "status" message the agent keeps editing.** It works everywhere. ⚠️ Unverified, but as we understand it Apple limits edits to regular messages (around 5 edits within 15 minutes), so it's only good for short-lived updates.
5. **Our own iMessage app extension** (`customizedMiniApp` in the SDK). It gives full control, but means building and distributing an iOS app extension. Too heavy for the hackathon.

**Recommendation:** use the live card as the dashboard, plus a dashboard image for anyone without the launcher.

## C2. Live card scrolling fights the conversation

**Observed** (✅ reported by the owner, 2026-10-10): scrolling or navigating inside the live card also scrolled the conversation history. The experience was poor.

**Why:** the card is a tiny web page embedded in a scrolling conversation. When the page itself can scroll, iOS can't tell which one the swipe is for, so both move, or the scroll continues past the page's edge into the conversation. The probe page was built like a regular website, which causes exactly this. Apple's design for in-conversation cards is "glance and tap," not "scroll."

**Fixes (all on the web page except 5):**

1. **The bubble shows a summary, with no scrolling.** When the page detects it's in the bubble (≈163×57 points), render a fixed summary that fits exactly, for example **"Plan v2 · 3 stops · ETA 6:40pm · Tap to open"**. Lock scrolling, so a swipe over the card simply scrolls the conversation and a tap opens it. Choose the layout from the viewport sizes we measured:
   ```js
   const mode = innerHeight < 120 ? "bubble" : innerHeight < 420 ? "compact" : "expanded";
   addEventListener("resize", () => {/* recompute mode and re-render */});
   ```
2. **The opened view behaves like an app, not a website.** A fixed header and tabs, with **one inner panel** that scrolls and stops at its own edges instead of carrying on into the conversation:
   ```css
   html, body { height: 100%; margin: 0; overflow: hidden; overscroll-behavior: none; }
   .panel     { height: 100%; overflow-y: auto; overscroll-behavior: contain; }
   ```
   The page never scrolls as a whole and never bounces; only the panel moves.
3. **No swipe-based controls.** Sideways swipes already do other things in iMessage (revealing timestamps, going back). No carousels and no swipe-to-vote. Use buttons and tabs with tap targets of at least 44 points.
4. **Stop the map from grabbing gestures.**
   - In the bubble: a static map image.
   - In the opened view: Google Maps `gestureHandling: "cooperative"`, so one finger scrolls the panel and two fingers move the map. Or give the map its own full-view "Map" tab.
5. **Use the bigger view if the launcher allows it.** iMessage apps normally have a **compact** presentation (keyboard height) and an **expanded** one (nearly full screen). The 280×300 points we measured looks like compact.
   - ⚠️ Untested: whether Photon's launcher lets the user expand it, for example by dragging the top edge up.
   - If it does, the full dashboard belongs in the expanded view. If not, ask Photon (ryan@photon.codes).
   - Our own iMessage extension (C1, fallback 5) would give full control, but it's heavy.

**How to verify (not built yet):** a **card test page** served by the agent that:
- switches layouts automatically (bubble / compact / expanded)
- reports every viewport change to the server, so we learn the real sizes and whether an expanded view exists
- includes a long list and a map, to confirm on a real iPhone that the scroll conflict is gone
