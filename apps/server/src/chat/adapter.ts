/**
 * Provider-neutral chat boundary. The Spectrum implementation (chat/spectrum-adapter.ts, the only file allowed
 * to import spectrum-ts) is written after the Photon probe confirms the real field shapes.
 */

export interface ChatSpaceRef {
  id: string;
  kind: "dm" | "group";
}

export type InboundContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; read(): Promise<Buffer> }
  /** Voice memos arrive either as Spectrum `voice` content or as an `audio/*` attachment; both map here. */
  | { type: "audio"; mimeType: string; durationSeconds: number | null; read(): Promise<Buffer> }
  | { type: "file"; mimeType: string; name: string }
  | { type: "poll_vote"; pollTitle: string; option: string; selected: boolean }
  | { type: "reaction"; emoji: string; targetMessageId: string | null }
  | { type: "other"; providerType: string };

export interface InboundMessage {
  /** Provider message id. Delivery is at-least-once: dedupe on this before side effects. */
  id: string;
  space: ChatSpaceRef;
  /** E.164 phone or email of the verified sender; null when the provider omits it. */
  senderHandle: string | null;
  sentAt: Date;
  content: InboundContent;
}

/** Persistable handle so a restart can update an existing card instead of re-sending it. */
export interface AppCardHandle {
  spaceId: string;
  messageId: string;
}

export interface ChatAdapter {
  /** Inbound messages only; the agent's own outbound echoes are filtered out. */
  messages(): AsyncIterable<InboundMessage>;
  sendText(space: ChatSpaceRef, text: string): Promise<void>;
  sendAppCard(space: ChatSpaceRef, url: string): Promise<AppCardHandle | null>;
  updateAppCard(card: AppCardHandle, url: string): Promise<void>;
  sendPoll(space: ChatSpaceRef, title: string, options: string[]): Promise<void>;
  stop(): Promise<void>;
}
