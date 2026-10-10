/**
 * The only non-probe module that imports spectrum-ts. Grows into the ChatAdapter implementation; for now it maps
 * Spectrum messages to provider-neutral ChatEvents for live ingestion into Tiger Data.
 */
import type { Message, Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { ChatEvent } from "../ingest/chat-events";

// Fields that get their own columns; everything else on the message is provider metadata.
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

async function describeContent(
  c: Message["content"],
): Promise<{ text: string | null; content: Record<string, unknown> }> {
  switch (c.type) {
    case "text":
      return { text: c.text, content: {} };
    case "markdown":
      return { text: c.markdown, content: { format: "markdown" } };
    case "attachment":
      // Metadata only — bytes stay with Photon (read() re-downloads on demand).
      return { text: null, content: { attachmentId: c.id, name: c.name, mimeType: c.mimeType, size: c.size ?? null } };
    case "voice":
      return {
        text: null,
        content: { mimeType: c.mimeType, durationSeconds: c.duration ?? null, size: c.size ?? null },
      };
    case "poll":
      return { text: c.title, content: { options: c.options.map((o) => o.title) } };
    case "poll_option":
      return { text: c.option.title, content: { poll: c.poll.title, selected: c.selected } };
    case "reaction":
      return { text: c.emoji, content: { targetId: c.target?.id ?? null } };
    case "read":
      return { text: null, content: { targetId: c.target?.id ?? null } };
    case "reply": {
      const inner = await describeContent(c.content as Message["content"]);
      return { text: inner.text, content: { ...inner.content, replyToId: c.target?.id ?? null } };
    }
    case "app": {
      const url = await c.url().catch(() => null);
      return { text: null, content: { url, live: c.live ?? false } };
    }
    default:
      return { text: null, content: { fields: Object.keys(c) } };
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

/** Dates → ISO strings, bytes → sizes, functions dropped, depth/length bounded; Postgres rejects \u0000. */
function jsonSafe(value: unknown, depth: number): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return clean(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (depth >= 4) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => jsonSafe(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined && typeof v !== "function")
      .map(([k, v]) => [k, jsonSafe(v, depth + 1)]),
  );
}

const clean = (s: string) => s.replaceAll("\u0000", "");
