import type { Db } from "../db/client";
import { chatEvents } from "../db/schema";

/** One chat event, provider-neutral. Built by chat/spectrum-adapter.ts → toChatEvent(). */
export interface ChatEvent {
  eventId: string;
  occurredAt: Date;
  chatId: string;
  chatType: "dm" | "group" | "unknown";
  platform: string;
  direction: "inbound" | "outbound";
  senderHandle: string | null;
  kind: string;
  text: string | null;
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
  source: "stream" | "send";
}

export interface ChatEventSink {
  record(event: ChatEvent): Promise<void>;
}

/**
 * Writes each event to Tiger Data as it happens. Idempotent (Spectrum delivers at-least-once), and a failed write
 * is reported, never thrown — a database hiccup must not take the chat loop down.
 */
export function createChatEventSink(db: Db, onError: (event: ChatEvent, error: unknown) => void): ChatEventSink {
  return {
    async record(event) {
      try {
        await db.insert(chatEvents).values(event).onConflictDoNothing();
      } catch (error) {
        onError(event, error);
      }
    },
  };
}
