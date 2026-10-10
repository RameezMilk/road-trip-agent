/**
 * Photon capability probe (spec build step 1). Uses spectrum-ts directly — not our ChatAdapter — so it
 * tests Photon itself and records raw field shapes. See docs/photon-probe.md for the phone test matrix.
 *
 *   npm run probe                              # listen only
 *   npm run probe -- --hello +1919…,+1984…     # also DM each registered teammate so they learn the line
 *   npm run probe -- --http-only               # serve /probe without connecting to Photon (page testing)
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  app as appCard,
  type ContentInput,
  Emoji,
  edit,
  type Message,
  option,
  poll,
  type Space,
  Spectrum,
} from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { toChatEvent } from "../chat/spectrum-adapter";
import { loadConfig, requireConfig } from "../config";
import { createDb } from "../db/client";
import { createChatEventSink } from "../ingest/chat-events";
import { type ProbeLog, probeRoutes } from "./probe-page";
import { ProbeStore, senderTag, spaceHash } from "./probe-store";

const HELP =
  "Probe commands: /ping /members /card /edit /poll /votes /confirm CODE /typing /react — or send a photo or voice memo.";

const { values: args, positionals } = parseArgs({
  options: { hello: { type: "string" }, "http-only": { type: "boolean", default: false } },
  allowPositionals: true,
});

/**
 * `--hello` numbers, tolerant of how people paste them: "+1 (984) 555-0101", comma lists, and stray
 * space-separated numbers (which the shell turns into positionals). Returns E.164 strings and rejects.
 */
function helloTargets(): { valid: string[]; invalid: string[] } {
  const raw = [args.hello ?? "", ...positionals].join(",");
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(",")) {
    const digits = part.replace(/[^\d+]/g, "");
    if (!digits) continue;
    const e164 = digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`;
    if (/^\+\d{8,15}$/.test(e164)) valid.push(e164);
    else invalid.push(part.trim());
  }
  return { valid: [...new Set(valid)], invalid };
}
const config = args["http-only"]
  ? loadConfig()
  : requireConfig(loadConfig(), "Photon probe", ["SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET"]);

// ---------- logging: JSONL in <repo>/probe-logs, never raw phone numbers or secrets ----------
const logDir = fileURLToPath(new URL("../../../../probe-logs/", import.meta.url));
mkdirSync(logDir, { recursive: true });
const logFile = `${logDir}probe-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;

const log: ProbeLog = (event, data) => {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  appendFileSync(logFile, `${line}\n`);
  console.log(line.length > 400 ? `${line.slice(0, 400)}…` : line);
};

const errorInfo = (err: unknown) => {
  const info = err instanceof Error ? { name: err.name, message: err.message.slice(0, 300) } : { message: String(err) };
  return /target not allowed/i.test(info.message)
    ? {
        ...info,
        hint: "Photon refused to send to this person from this project (registered + active in Spectrum → Users?)",
      }
    : info;
};

function spaceInfo(space: Space) {
  if (imessage.is(space)) return { hash: spaceHash(space.id), type: space.type, phone: space.phone };
  return { hash: spaceHash(space.id), type: "unknown", platform: space.__platform };
}

/** Field names present on a message (minus methods) — tells us what the provider actually populates. */
function shapeOf(value: object): string[] {
  return Object.keys(value).filter((k) => typeof (value as Record<string, unknown>)[k] !== "function");
}

function describeContent(content: Message["content"]): Record<string, unknown> {
  switch (content.type) {
    case "text": {
      const trimmed = content.text.trim();
      // Log command text only; casual chat is recorded by length.
      return {
        type: "text",
        length: content.text.length,
        ...(trimmed.startsWith("/") && { command: trimmed.slice(0, 80) }),
      };
    }
    case "attachment":
      return { type: "attachment", name: content.name, mimeType: content.mimeType, size: content.size };
    case "voice":
      return { type: "voice", mimeType: content.mimeType, duration: content.duration, size: content.size };
    case "poll":
      return { type: "poll", title: content.title, options: content.options.map((o) => o.title) };
    case "poll_option":
      return {
        type: "poll_option",
        poll: content.poll.title,
        option: content.option.title,
        selected: content.selected,
      };
    case "reaction":
      return { type: "reaction", emoji: content.emoji };
    default:
      return { type: content.type, keys: Object.keys(content) };
  }
}

// ---------- state (probe-only, in memory) ----------
const store = new ProbeStore();
const seen = new Set<string>();
const cards = new Map<string, { message: Message; url: string; rev: number }>();
const pollEvents = new Map<string, string[]>();

// ---------- HTTP: /probe page + beacon ----------
const http = new Hono();
http.get("/health", (c) => c.json({ ok: true, mode: "probe" }));
http.route(
  "/",
  probeRoutes({ store, log, mapsBrowserKey: config.GOOGLE_MAPS_BROWSER_KEY, mapId: config.GOOGLE_MAP_ID }),
);
const server = serve({ fetch: http.fetch, port: config.PORT }, ({ port }) =>
  log("http_listening", { port, publicBaseUrl: config.PUBLIC_BASE_URL ?? null }),
);

// ---------- Spectrum ----------
if (args["http-only"]) {
  log("http_only_mode", { note: "Spectrum not started; /probe and /api/probe/beacon only" });
  await new Promise(() => {}); // keep serving until Ctrl-C
}
const spectrum = await Spectrum({
  projectId: config.SPECTRUM_PROJECT_ID as string,
  projectSecret: config.SPECTRUM_PROJECT_SECRET as string,
  providers: [imessage.config()],
}).catch((err: unknown) => {
  log("spectrum_connect_failed", {
    error: errorInfo(err),
    hint: "check SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET",
  });
  process.exit(1);
});
log("spectrum_connected", { project: { name: spectrum.config.name, slug: spectrum.config.slug }, logFile });
const im = imessage(spectrum);

// ---------- Tiger Data: every chat event, written live ----------
const tiger = config.DATABASE_URL ? createDb(config) : null;
const sink = tiger
  ? createChatEventSink(tiger.db, (event, err) =>
      log("tiger_write_failed", { eventId: event.eventId, kind: event.kind, error: errorInfo(err) }),
    )
  : null;
log(
  tiger ? "tiger_sink_enabled" : "tiger_sink_disabled",
  tiger ? {} : { hint: "set DATABASE_URL to stream to Tiger Data" },
);

function recordEvent(space: Space, message: Message, source: "stream" | "send") {
  if (!sink) return;
  toChatEvent(space, message, source)
    .then((event) => sink.record(event))
    .catch((err) => log("tiger_map_failed", { messageId: message.id, error: errorInfo(err) }));
}

/** The agent's own messages don't come back on the stream, so they're recorded when sent. */
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

const targets = helloTargets();
if (targets.invalid.length > 0) log("outreach_skipped_invalid", { count: targets.invalid.length });
for (const phone of targets.valid) {
  // On a shared-pool line space.create only builds the DM id locally; the send is what Photon authorizes.
  const dm = await im.space.create(await im.user(phone));
  try {
    await send(dm, "Road-trip probe online 👋 Reply /ping (or /help).");
    log("outreach_sent", { to: senderTag(phone), space: spaceInfo(dm) });
  } catch (err) {
    log("outreach_failed", { to: senderTag(phone), space: spaceInfo(dm), error: errorInfo(err) });
  }
}

const shutdown = async () => {
  log("shutdown", {});
  await spectrum.stop().catch(() => {});
  await tiger?.close().catch(() => {});
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for await (const [space, message] of spectrum.messages) {
  // At-least-once delivery: dedupe on message id.
  if (seen.has(message.id)) {
    log("duplicate_delivery", { messageId: message.id });
    continue;
  }
  seen.add(message.id);
  if (seen.size > 5000) seen.delete(seen.values().next().value as string);
  recordEvent(space, message, "stream");

  const record = {
    messageId: message.id,
    platform: message.platform,
    direction: message.direction,
    space: spaceInfo(space),
    sender: senderTag(message.sender?.id),
    lagMs: Date.now() - message.timestamp.getTime(),
    content: describeContent(message.content),
    shape: shapeOf(message),
  };
  if (message.direction === "outbound") {
    // Never react to our own messages.
    log("outbound_echo", record);
    continue;
  }
  log("inbound", record);
  handle(space, message).catch((err) => log("handler_error", { messageId: message.id, error: errorInfo(err) }));
}

async function handle(space: Space, message: Message) {
  const { content } = message;
  const tag = senderTag(message.sender?.id);
  const info = spaceInfo(space);

  if (content.type === "attachment" || content.type === "voice") {
    const bytes = await content.read(); // each read() re-downloads — read once
    const kind =
      content.type === "voice" ? "voice" : content.mimeType.startsWith("audio/") ? "audio attachment" : "attachment";
    log("attachment_read", { messageId: message.id, kind, mimeType: content.mimeType, bytes: bytes.length });
    await reply(message, `📎 Got ${kind}: ${content.mimeType}, ${Math.max(1, Math.round(bytes.length / 1024))} KB`);
    return;
  }

  if (content.type === "poll_option") {
    const events = pollEvents.get(space.id) ?? [];
    events.push(`${tag} ${content.selected ? "+" : "−"} ${content.option.title}`);
    pollEvents.set(space.id, events.slice(-20));
    return;
  }

  if (content.type !== "text") return;
  const [rawCommand = "", ...rest] = content.text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase();
  if (!command.startsWith("/")) {
    // Groups: stay quiet on casual chat. DMs: one-line hint, which also exercises the reply path.
    if (info.type === "dm") await reply(message, `I only answer slash commands — try /ping. ${HELP}`);
    return;
  }

  switch (command) {
    case "/help":
      await reply(message, HELP);
      return;

    case "/ping": {
      const lag = Math.round((Date.now() - message.timestamp.getTime()) / 100) / 10;
      await reply(
        message,
        `pong · ${info.type} · chat ${info.hash} · you ${tag} · line ${"phone" in info ? info.phone : "?"} · lag ${lag}s`,
      );
      return;
    }

    case "/members": {
      const members = await space.getMembers();
      log("members", { space: info, count: members.length, members: members.map((m) => senderTag(m.id)) });
      await reply(
        message,
        `${members.length} member(s) besides the agent: ${members.map((m) => senderTag(m.id)).join(", ")}`,
      );
      return;
    }

    case "/card": {
      if (!config.PUBLIC_BASE_URL) {
        await reply(message, "PUBLIC_BASE_URL isn't set on the server — start ngrok and set it in .env.");
        return;
      }
      const url = `${config.PUBLIC_BASE_URL}/probe?s=${info.hash}&n=${randomBytes(6).toString("hex")}`;
      const sent = await send(space, appCard(url, { live: true }));
      const session = (sent as { miniAppCardSession?: unknown } | undefined)?.miniAppCardSession;
      log("card_sent", { space: info, url, returned: sent ? shapeOf(sent) : null, hasCardSession: Boolean(session) });
      if (sent) cards.set(space.id, { message: sent, url, rev: 1 });
      else await reply(message, "Card send returned nothing (no handle) — /edit won't work.");
      return;
    }

    case "/edit": {
      const card = cards.get(space.id);
      if (!card) {
        await reply(message, "No card in this chat yet — send /card first.");
        return;
      }
      card.rev += 1;
      const url = `${card.url}&rev=${card.rev}`;
      await send(space, edit(appCard(url, { live: true }), card.message));
      log("card_edited", { space: info, url });
      await reply(message, `Edited the card in place (rev ${card.rev}). Did the same bubble update?`);
      return;
    }

    case "/poll": {
      const sent = await send(
        space,
        poll("Probe poll — pick any", option("Blue Ridge overlook"), option("Waterfall hike"), option("BBQ lunch")),
      );
      log("poll_sent", { space: info, returned: sent ? shapeOf(sent) : null });
      return;
    }

    case "/votes": {
      const events = pollEvents.get(space.id) ?? [];
      await reply(
        message,
        events.length ? `Poll events seen:\n${events.join("\n")}` : "No poll votes received in this chat yet.",
      );
      return;
    }

    case "/confirm": {
      const result = store.consume(rest[0] ?? "");
      if (!result.ok) {
        log("confirm_rejected", { space: info, sender: tag, reason: result.reason });
        await reply(message, `❌ /confirm rejected: ${result.reason}`);
        return;
      }
      const s = result.session;
      const sameChat = s.cardSpaceHash === null ? "unknown" : s.cardSpaceHash === info.hash ? "yes" : "NO";
      log("confirm_matched", { space: info, sender: tag, sameChat, ageMs: Date.now() - s.createdAt });
      await reply(
        message,
        `✅ Code matched a page session from ${Math.round((Date.now() - s.createdAt) / 1000)}s ago → committed to ${tag} in this ${info.type}. Card came from this chat: ${sameChat}.`,
      );
      return;
    }

    case "/typing":
      await space.responding(() => new Promise((resolve) => setTimeout(resolve, 2500)));
      await reply(message, "Typing test done — did a typing bubble show for ~2.5s?");
      return;

    case "/react":
      await message.react(Emoji.like);
      return;

    default:
      return;
  }
}
