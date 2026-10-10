import type { CommandName, VoteState } from "@rta/contracts";

/**
 * Slash commands are plain text our backend interprets — there is no iOS-native command menu.
 * Parsing is syntax only; membership, host rights and plan-version checks happen in the handlers.
 */
export type ParsedCommand =
  | { name: "trip"; origin: string; destination: string }
  | { name: "join" }
  | { name: "inspire" }
  | { name: "plan" }
  | { name: "vote"; optionId: string; state: VoteState }
  | { name: "confirm"; code: string }
  | { name: "approve"; version: number }
  | { name: "map" }
  | { name: "done"; stopId: string }
  | { name: "replan"; change: string }
  | { name: "status" }
  | { name: "help" }
  | { name: "cancel" };

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; name: CommandName; usage: string };

export const COMMAND_USAGE: Record<CommandName, string> = {
  trip: "/trip <origin> to <destination>",
  join: "/join",
  inspire: "/inspire (attach a photo or screenshot)",
  plan: "/plan",
  vote: "/vote <option-id> [like|pass|must|clear]",
  confirm: "/confirm <code>",
  approve: "/approve <version>",
  map: "/map",
  done: "/done <stop-id>",
  replan: "/replan <change>",
  status: "/status",
  help: "/help",
  cancel: "/cancel",
};

const VOTE_WORDS: Record<string, VoteState> = { like: "like", pass: "pass", must: "must", clear: "abstain" };
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** Returns null for anything that isn't one of our commands — the agent stays quiet on casual chat. */
export function parseCommand(text: string): ParseResult | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  if (!isCommandName(name)) return null;
  const rest = (match[2] ?? "").trim();
  const args = rest ? rest.split(/\s+/) : [];
  const fail = (): ParseResult => ({ ok: false, name, usage: COMMAND_USAGE[name] });
  const ok = (command: ParsedCommand): ParseResult => ({ ok: true, command });

  switch (name) {
    case "trip": {
      // Split on the first standalone "to"; ambiguous names are resolved and confirmed later.
      const parts = /^(.+?)\s+to\s+(.+)$/i.exec(rest);
      const origin = parts?.[1]?.trim();
      const destination = parts?.[2]?.trim();
      return origin && destination ? ok({ name, origin, destination }) : fail();
    }
    case "vote": {
      const [optionId, word = "like", ...extra] = args;
      const state = VOTE_WORDS[word.toLowerCase()];
      return optionId && TOKEN.test(optionId) && state && extra.length === 0 ? ok({ name, optionId, state }) : fail();
    }
    case "confirm": {
      const code = args[0]?.toUpperCase();
      return code && args.length === 1 && /^[A-Z0-9]{4,12}$/.test(code) ? ok({ name, code }) : fail();
    }
    case "approve": {
      const version = Number(args[0]?.replace(/^v/i, ""));
      return args.length === 1 && Number.isInteger(version) && version > 0 ? ok({ name, version }) : fail();
    }
    case "done": {
      const stopId = args[0];
      return stopId && args.length === 1 && TOKEN.test(stopId) ? ok({ name, stopId }) : fail();
    }
    case "replan":
      return rest ? ok({ name, change: rest.slice(0, 500) }) : fail();
    default:
      // Argument-free commands ignore trailing text (e.g. "/plan please").
      return ok({ name });
  }
}

function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(COMMAND_USAGE, name);
}
