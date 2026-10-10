import { createHash, randomInt } from "node:crypto";

// Unambiguous alphabet: no 0/O, 1/I/L, so a code read off a phone screen survives retyping.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;

export interface PageSession {
  code: string;
  /** `s` query param from the card URL: hash of the space the card was sent to. */
  cardSpaceHash: string | null;
  userAgent: string;
  createdAt: number;
  usedAt: number | null;
}

export type ConsumeResult =
  | { ok: true; session: PageSession }
  | { ok: false; reason: "malformed" | "unknown" | "expired" | "used" };

/** In-memory stand-in for the real draft/confirmation store; probe-only, lost on restart. */
export class ProbeStore {
  private readonly sessions = new Map<string, PageSession>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(input: { cardSpaceHash: string | null; userAgent: string }): PageSession {
    this.prune();
    let code = "";
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    } while (this.sessions.has(code));
    const session: PageSession = { code, ...input, createdAt: this.now(), usedAt: null };
    this.sessions.set(code, session);
    return session;
  }

  consume(rawCode: string): ConsumeResult {
    const code = rawCode.trim().toUpperCase();
    if (!new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code)) return { ok: false, reason: "malformed" };
    const session = this.sessions.get(code);
    if (!session) return { ok: false, reason: "unknown" };
    if (session.usedAt !== null) return { ok: false, reason: "used" };
    if (this.now() - session.createdAt > CODE_TTL_MS) return { ok: false, reason: "expired" };
    session.usedAt = this.now();
    return { ok: true, session };
  }

  private prune() {
    const cutoff = this.now() - 2 * CODE_TTL_MS;
    for (const [code, s] of this.sessions) if (s.createdAt < cutoff) this.sessions.delete(code);
  }
}

/** Short, stable, non-reversible label for a phone/email handle: hash prefix + last 4 chars. */
export function senderTag(handle: string | undefined): string {
  if (!handle) return "unknown";
  const digest = createHash("sha256").update(handle).digest("hex").slice(0, 8);
  return `${digest}…${handle.slice(-4)}`;
}

export function spaceHash(spaceId: string): string {
  return createHash("sha256").update(spaceId).digest("hex").slice(0, 10);
}
