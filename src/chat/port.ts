import type { CardRef } from "../schemas";

/** Who a message goes to. memberId/tripId are carried so outbound messages are stored per member. */
export interface Recipient {
  handle: string;
  chatId: string | null;
  memberId: string | null;
  tripId: string | null;
}

/** Bubble text for an app card (Photon renders it under the card image). */
export interface CardLayout {
  caption: string;
  subcaption: string;
  /** Show the Trippy mascot artwork on the card, with this text overlaid. Adapters may ignore it. */
  art?: { title: string; subtitle?: string };
}

/** The only way the engine talks to iMessage. Implemented by Spectrum in production and a fake in tests. */
export interface ChatPort {
  sendText(to: Recipient, text: string): Promise<void>;
  /** Returns what's needed to edit the card later, or null if the platform gave nothing back. */
  sendCard(to: Recipient, url: string, layout: CardLayout): Promise<CardRef | null>;
  /** Edits a previously sent live card in place; returns the (possibly new) edit handle. */
  editCard(to: Recipient, card: CardRef, url: string, layout: CardLayout): Promise<CardRef | null>;
  /** Sends a file (the send-off GIF). */
  sendAttachment?(to: Recipient, path: string, mimeType: string): Promise<void>;
  /** Shows the typing indicator until the next message (best effort). */
  typing?(to: Recipient): Promise<void>;
}

/** Raised when Photon refuses a recipient (not registered in the Photon dashboard on the Pro plan). */
export class RecipientNotAllowedError extends Error {
  constructor(readonly handle: string) {
    super(`recipient not allowed: ${handle}`);
    this.name = "RecipientNotAllowedError";
  }
}

export function isRecipientNotAllowed(error: unknown): boolean {
  if (error instanceof RecipientNotAllowedError) return true;
  const text = String((error as { message?: unknown })?.message ?? error);
  return /target not allowed|not allowed for this project/i.test(text);
}

/** First names for handles, from the chat provider's own user records (Photon project users). */
export interface NameDirectory {
  /** The person's first name, or null when the provider doesn't know it (then the agent asks). */
  firstName(handle: string): Promise<string | null>;
}

export const noNames: NameDirectory = { firstName: async () => null };
