import { z } from "zod";
import { Handle, InviteCode } from "./primitives";

/**
 * Every keyword the agent treats as a command. Anything else in a DM is natural language,
 * handled according to the trip phase. Keywords are accepted with or without a leading "/".
 */
export const ChatCommandName = z.enum([
  "newtrip",
  "invite",
  "join",
  "ready",
  "approve",
  "status",
  "dashboard",
  "help",
  "cancel",
  "leave",
]);
export type ChatCommandName = z.infer<typeof ChatCommandName>;

export const ChatCommand = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("newtrip"), title: z.string().trim().min(1).max(80).nullable() }),
  z.strictObject({ name: z.literal("invite"), handles: z.array(Handle).min(1).max(9) }),
  z.strictObject({ name: z.literal("join"), code: InviteCode.nullable() }),
  z.strictObject({ name: z.literal("ready") }),
  z.strictObject({ name: z.literal("approve") }),
  z.strictObject({ name: z.literal("status") }),
  z.strictObject({ name: z.literal("dashboard") }),
  z.strictObject({ name: z.literal("help") }),
  z.strictObject({ name: z.literal("cancel") }),
  z.strictObject({ name: z.literal("leave") }),
]);
export type ChatCommand = z.infer<typeof ChatCommand>;

export const COMMAND_USAGE: Record<ChatCommandName, string> = {
  newtrip: "newtrip — start a trip",
  invite: "invite +19195551234 — host: text a friend an invite",
  join: "join CODE — join a friend's trip",
  ready: "ready — done answering",
  approve: "approve — approve the plan",
  status: "status — where things stand",
  dashboard: "dashboard — resend the trip dashboard",
  help: "help — this list",
  cancel: "cancel — host: cancel the trip",
  leave: "leave — leave the trip (the others carry on)",
};
