import { E164, type Handle } from "../schemas";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalises a typed phone number (US default) or Apple ID email to an iMessage handle. */
export function normalizeHandle(raw: string): Handle | null {
  const trimmed = raw.trim();
  if (EMAIL.test(trimmed)) return trimmed.toLowerCase();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  let candidate: string;
  if (plus) candidate = `+${digits}`;
  else if (digits.length === 10) candidate = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) candidate = `+${digits}`;
  else return null;
  return E164.safeParse(candidate).success ? candidate : null;
}

const HANDLE_PATTERN = /[^\s,;@]+@[^\s,;@]+\.[^\s,;@]+|\+?\d[\d\s().-]{6,}\d/g;

/** Pulls every phone number / email out of free text such as "+1 919 555 1234, sam@icloud.com". */
export function extractHandles(text: string): Handle[] {
  const found = new Set<Handle>();
  for (const match of text.matchAll(HANDLE_PATTERN)) {
    const handle = normalizeHandle(match[0]);
    if (handle) found.add(handle);
  }
  return [...found];
}

/** Spectrum DM chat id → handle (`any;-;+19195551234` → `+19195551234`). */
export function handleFromChatId(chatId: string): string | null {
  const parts = chatId.split(";-;");
  return parts.length === 2 && parts[1] ? parts[1] : null;
}
