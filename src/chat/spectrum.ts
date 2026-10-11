/**
 * The only module that imports spectrum-ts (Photon). Maps the Spectrum stream to provider-neutral inbound
 * events and implements ChatPort for sends, app cards and in-place card edits. Every outbound message is
 * recorded to `chat_events` here, because the agent's own sends never come back on the stream.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { app, attachment, type Message, type Space, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Repo } from "../db/repo";
import type { CardRef, ChatEvent } from "../schemas";
import {
  type CardLayout,
  type ChatPort,
  isRecipientNotAllowed,
  type Recipient,
  RecipientNotAllowedError,
} from "./port";

type Log = (event: string, data?: Record<string, unknown>) => void;

export type InboundKind = "text" | "attachment" | "voice" | "reaction" | "read" | "other";

export interface InboundEvent {
  messageId: string;
  chatId: string;
  isGroup: boolean;
  handle: string | null;
  kind: InboundKind;
  text: string | null;
  occurredAt: Date;
  /** Ready to store; tripId/memberId are filled in by the runtime. */
  event: ChatEvent;
}

const CORE_KEYS = new Set(["id", "content", "direction", "platform", "sender", "space", "timestamp"]);

/** Trippy card artwork (900×600 JPEG, which is what Photon's card image slot accepts). */
const CARD_ART_PATH = new URL("../../web/trippy-card.jpg", import.meta.url);

export class SpectrumChat implements ChatPort {
  private readonly spaces = new Map<string, Space>();
  private readonly seen = new Set<string>();
  /** Loaded on first use; null once loading it, or sending a card with it, has failed. */
  private cardArt: Uint8Array<ArrayBuffer> | null | undefined;

  private constructor(
    private readonly spectrum: Awaited<ReturnType<typeof Spectrum>>,
    private readonly repo: Repo,
    private readonly log: Log,
    private readonly cardLive: boolean,
  ) {}

  static async connect(options: {
    projectId: string;
    projectSecret: string;
    repo: Repo;
    log: Log;
    /** Live cards render inline (bubble-sized); non-live cards open the expanded mini-app when tapped. */
    cardLive: boolean;
  }): Promise<SpectrumChat> {
    const spectrum = await Spectrum({
      projectId: options.projectId,
      projectSecret: options.projectSecret,
      providers: [imessage.config()],
    });
    options.log("spectrum_connected", { project: spectrum.config.slug });
    return new SpectrumChat(spectrum, options.repo, options.log, options.cardLive);
  }

  /** Inbound messages only, deduped in memory (the DB insert is the durable dedupe). */
  async *messages(): AsyncIterable<InboundEvent> {
    for await (const [space, message] of this.spectrum.messages) {
      if (message.direction === "outbound") continue;
      if (this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
      // Reply on the exact conversation the person wrote from (it carries Photon's routing for their line).
      const sender = message.sender?.id;
      if (sender && !(imessage.is(space) && space.type === "group")) this.spaces.set(sender, space);
      try {
        yield await toInbound(space, message);
      } catch (error) {
        this.log("inbound_map_failed", { error: String(error) });
      }
    }
  }

  async stop(): Promise<void> {
    await this.spectrum.stop();
  }

  private async spaceFor(to: Recipient): Promise<Space> {
    const cached = this.spaces.get(to.handle);
    if (cached) return cached;
    const im = imessage(this.spectrum);
    const space = await im.space.create(await im.user(to.handle));
    this.spaces.set(to.handle, space);
    return space;
  }

  /**
   * Photon briefly refuses numbers that were just added to the project ("Target not allowed"), then
   * accepts them, so that error gets two short retries before it is reported.
   */
  private async send(to: Recipient, content: Parameters<Space["send"]>[0]): Promise<Message | undefined> {
    const space = await this.spaceFor(to);
    for (const delayMs of [0, 2000, 5000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        return (await space.send(content)) as Message | undefined;
      } catch (error) {
        if (!isRecipientNotAllowed(error)) throw error;
        this.log("send_not_allowed_retry", { memberId: to.memberId, delayMs });
      }
    }
    throw new RecipientNotAllowedError(to.handle);
  }

  async sendText(to: Recipient, text: string): Promise<void> {
    const sent = await this.send(to, text);
    await this.recordOutbound(to, sent, "text", text, {});
  }

  /**
   * Builds the provider layout. Card art is optional decoration: when a card with art fails but the same
   * card without it succeeds, the art is switched off for the rest of the process.
   */
  private async withArt<T>(layout: CardLayout, run: (l: Record<string, unknown>) => Promise<T>): Promise<T> {
    const plain = { caption: layout.caption, subcaption: layout.subcaption };
    const image = layout.art ? this.loadCardArt() : null;
    if (!layout.art || !image) return run(plain);
    try {
      return await run({ ...plain, image, imageTitle: layout.art.title, imageSubtitle: layout.art.subtitle });
    } catch (error) {
      if (isRecipientNotAllowed(error)) throw error;
      const result = await run(plain); // if this fails too, the art wasn't the problem: rethrow that
      this.cardArt = null;
      this.log("card_art_disabled", { error: String(error) });
      return result;
    }
  }

  private loadCardArt(): Uint8Array<ArrayBuffer> | null {
    if (this.cardArt === undefined) {
      try {
        this.cardArt = new Uint8Array(readFileSync(CARD_ART_PATH));
      } catch (error) {
        this.cardArt = null;
        this.log("card_art_missing", { error: String(error) });
      }
    }
    return this.cardArt;
  }

  async sendCard(to: Recipient, url: string, layout: CardLayout): Promise<CardRef | null> {
    const sent = await this.withArt(layout, (l) => this.send(to, app(url, { live: this.cardLive, layout: l })));
    await this.recordOutbound(to, sent, "app", null, { url, ...layout });
    const session = (sent as { miniAppCardSession?: Record<string, unknown> } | undefined)?.miniAppCardSession;
    return sent && session ? { messageId: sent.id, session: { ...session } } : null;
  }

  async sendAttachment(to: Recipient, path: string, mimeType: string): Promise<void> {
    const name = path.split("/").at(-1) ?? "attachment";
    const sent = await this.send(to, attachment(path, { mimeType, name }));
    await this.recordOutbound(to, sent, "attachment", null, { name, mimeType });
  }

  async typing(to: Recipient): Promise<void> {
    await (await this.spaceFor(to)).startTyping();
  }

  /**
   * Edits a live card in place. Spectrum needs the original outbound Message (for its miniAppCardSession);
   * after a restart we only have the stored session, so we rebuild a minimal outbound target. The provider
   * replaces the session on every edit, so the new one is returned for storage.
   */
  async editCard(to: Recipient, card: CardRef, url: string, layout: CardLayout): Promise<CardRef | null> {
    const space = await this.spaceFor(to);
    const target = {
      id: card.messageId,
      direction: "outbound",
      platform: "imessage",
      content: { type: "app" },
      space,
      timestamp: new Date(),
      miniAppCardSession: { ...card.session },
    };
    await this.withArt(layout, (l) =>
      space.edit(target as unknown as Message, app(url, { live: this.cardLive, layout: l })),
    );
    await this.recordOutbound(to, undefined, "app_edit", null, { url, ...layout, editOf: card.messageId });
    return { messageId: card.messageId, session: { ...target.miniAppCardSession } };
  }

  private async recordOutbound(
    to: Recipient,
    sent: Message | undefined,
    kind: string,
    text: string | null,
    content: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.repo.recordChatEvent({
        eventId: sent?.id ?? `out-${randomUUID()}`,
        occurredAt: sent?.timestamp instanceof Date ? sent.timestamp : new Date(),
        chatId: to.chatId ?? `any;-;${to.handle}`,
        tripId: to.tripId,
        memberId: to.memberId,
        direction: "outbound",
        handle: to.handle,
        kind,
        text: text === null ? null : clean(text),
        content,
        metadata: sent ? providerMetadata(sent) : {},
      });
    } catch (error) {
      this.log("record_outbound_failed", { error: String(error) });
    }
  }
}

export async function toInbound(space: Space, message: Message): Promise<InboundEvent> {
  const isGroup = imessage.is(space) ? space.type === "group" : space.id.includes(";+;");
  const described = await describeContent(message.content);
  const handle = message.sender?.id ?? null;
  return {
    messageId: message.id,
    chatId: space.id,
    isGroup,
    handle,
    kind: described.kind,
    text: described.text === null ? null : clean(described.text),
    occurredAt: message.timestamp instanceof Date ? message.timestamp : new Date(),
    event: {
      eventId: message.id,
      occurredAt: message.timestamp instanceof Date ? message.timestamp : new Date(),
      chatId: space.id,
      tripId: null,
      memberId: null,
      direction: "inbound",
      handle,
      kind: message.content.type,
      text: described.text === null ? null : clean(described.text),
      content: described.content,
      metadata: providerMetadata(message),
    },
  };
}

async function describeContent(
  c: Message["content"],
): Promise<{ kind: InboundKind; text: string | null; content: Record<string, unknown> }> {
  switch (c.type) {
    case "text":
      return { kind: "text", text: c.text, content: { type: "text" } };
    case "markdown":
      return { kind: "text", text: c.markdown, content: { type: "markdown" } };
    case "attachment":
      // Metadata only — bytes stay with Photon.
      return {
        kind: "attachment",
        text: null,
        content: { type: "attachment", name: c.name, mimeType: c.mimeType, size: c.size ?? null },
      };
    case "voice":
      return {
        kind: "voice",
        text: null,
        content: { type: "voice", mimeType: c.mimeType, durationSeconds: c.duration ?? null },
      };
    case "reaction":
      return { kind: "reaction", text: c.emoji, content: { type: "reaction", targetId: c.target?.id ?? null } };
    case "read":
      return { kind: "read", text: null, content: { type: "read", targetId: c.target?.id ?? null } };
    case "reply": {
      const inner = await describeContent(c.content as Message["content"]);
      return { ...inner, content: { ...inner.content, replyToId: c.target?.id ?? null } };
    }
    default:
      return { kind: "other", text: null, content: { type: c.type } };
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
