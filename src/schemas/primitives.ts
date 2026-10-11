import { randomBytes } from "node:crypto";
import { z } from "zod";

// --- IDs: `<prefix>_<base62>` so a stray ID can never be mistaken for another kind ---------------

const ID_BODY = "[A-Za-z0-9]{12,32}";
const prefixedId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_${ID_BODY}$`));

export const TripId = prefixedId("trip");
export const MemberId = prefixedId("mem");
export const RequirementId = prefixedId("req");
export const PollId = prefixedId("poll");
export const OptionId = prefixedId("opt");
export const StopId = prefixedId("stop");
export const EventId = prefixedId("evt");

export type IdPrefix = "trip" | "mem" | "req" | "poll" | "opt" | "stop" | "evt";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomString(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomString(BASE62, 16)}`;
}

/** Unguessable ID used in public dashboard URLs. */
export const PublicId = z.string().regex(/^[A-Za-z0-9]{20}$/);
export const newPublicId = () => randomString(BASE62, 20);

/** Short code a friend can type: no 0/O/1/I/L. */
const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const InviteCode = z.string().regex(/^[2-9A-HJKMNP-Z]{6}$/);
export const newInviteCode = () => randomString(INVITE_ALPHABET, 6);

/** Per-(poll, member) capability token for the poll widget link. */
export const PollToken = z.string().regex(/^[A-Za-z0-9]{24}$/);
export const newPollToken = () => randomString(BASE62, 24);

// --- Values -------------------------------------------------------------------------------------

export const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/);
/** An iMessage handle: E.164 phone number or Apple ID email. */
export const Handle = z.union([E164, z.email()]);
export type Handle = z.infer<typeof Handle>;

export const IsoDateTime = z.iso.datetime({ offset: true });
export const LocalDate = z.iso.date();
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const IanaTimeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "unknown IANA time zone");

export const LatLng = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLng>;

export const Usd = z.number().min(0).max(100_000);
export const Meters = z.int().min(0);
export const Seconds = z.int().min(0);
export const Minutes = z
  .int()
  .min(0)
  .max(24 * 60);
export const FirstName = z.string().trim().min(1).max(40);
