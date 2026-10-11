import { ChatCommand, ChatCommandName, COMMAND_USAGE, InviteCode } from "../schemas";
import { extractHandles } from "./phone";

export type ParseResult =
  | { kind: "command"; command: ChatCommand }
  | { kind: "usage"; name: ChatCommandName; usage: string }
  | null;

/** Multi-word spellings people naturally type, mapped onto the canonical keyword. */
const PHRASES: ReadonlyArray<readonly [RegExp, ChatCommandName]> = [
  [/^new trip\b/i, "newtrip"],
  [/^start (?:a )?(?:new )?trip\b/i, "newtrip"],
];

const ARG_COMMANDS = new Set<ChatCommandName>(["newtrip", "invite", "join"]);

/**
 * Parses a DM into a schema-validated command, or returns null when it is natural language.
 * A command must start the message (an optional "/" is allowed). Commands without arguments
 * must be the whole message, so "ready to roll?" is natural language but "Ready!" is `ready`.
 */
export function parseCommand(text: string): ParseResult {
  let body = text.trim();
  if (!body) return null;
  if (body.startsWith("/")) body = body.slice(1);

  let name: ChatCommandName | undefined;
  let rest = "";
  for (const [pattern, phraseName] of PHRASES) {
    const match = body.match(pattern);
    if (match) {
      name = phraseName;
      rest = body.slice(match[0].length);
      break;
    }
  }
  if (!name) {
    const match = body.match(/^([A-Za-z]+)(.*)$/s);
    if (!match) return null;
    const parsed = ChatCommandName.safeParse(match[1]?.toLowerCase());
    if (!parsed.success) return null;
    name = parsed.data;
    rest = match[2] ?? "";
  }

  rest = rest.trim();
  if (!ARG_COMMANDS.has(name)) {
    // Allow trailing punctuation / emoji ("ready!", "approve 👍"), nothing else.
    if (/[\p{L}\p{N}]/u.test(rest)) return null;
    return { kind: "command", command: ChatCommand.parse({ name }) };
  }

  const usage = (): ParseResult => ({ kind: "usage", name, usage: COMMAND_USAGE[name] });
  switch (name) {
    case "newtrip": {
      const title = rest.replace(/^[:\-–—\s]+/, "").trim();
      return { kind: "command", command: ChatCommand.parse({ name, title: title ? title.slice(0, 80) : null }) };
    }
    case "invite": {
      const handles = extractHandles(rest);
      if (handles.length === 0) return usage();
      return { kind: "command", command: ChatCommand.parse({ name, handles: handles.slice(0, 9) }) };
    }
    case "join": {
      const token = rest.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (!token) return { kind: "command", command: ChatCommand.parse({ name, code: null }) };
      const code = InviteCode.safeParse(token);
      return code.success ? { kind: "command", command: ChatCommand.parse({ name, code: code.data }) } : usage();
    }
    default:
      return null;
  }
}

export function helpText(): string {
  return ["Commands:", ...ChatCommandName.options.map((n) => `• ${COMMAND_USAGE[n]}`)].join("\n");
}
