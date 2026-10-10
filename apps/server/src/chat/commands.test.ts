import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands";

describe("parseCommand", () => {
  it.each([
    ["/trip Chapel Hill to Asheville", { name: "trip", origin: "Chapel Hill", destination: "Asheville" }],
    ["/TRIP  Durham, NC  TO  Boone, NC ", { name: "trip", origin: "Durham, NC", destination: "Boone, NC" }],
    ["/vote R1", { name: "vote", optionId: "R1", state: "like" }],
    ["/vote S2 must", { name: "vote", optionId: "S2", state: "must" }],
    ["/vote S2 clear", { name: "vote", optionId: "S2", state: "abstain" }],
    ["/confirm k7m2qp", { name: "confirm", code: "K7M2QP" }],
    ["/approve v3", { name: "approve", version: 3 }],
    ["/approve 2", { name: "approve", version: 2 }],
    ["/done stop_lunch", { name: "done", stopId: "stop_lunch" }],
    ["/replan arrive 45 minutes earlier", { name: "replan", change: "arrive 45 minutes earlier" }],
    ["/plan", { name: "plan" }],
    ["/help me", { name: "help" }],
  ])("parses %j", (text, command) => {
    expect(parseCommand(text)).toEqual({ ok: true, command });
  });

  it.each([
    ["/trip Asheville", "trip"],
    ["/vote", "vote"],
    ["/vote R1 maybe", "vote"],
    ["/confirm", "confirm"],
    ["/confirm AB CD", "confirm"],
    ["/approve latest", "approve"],
    ["/approve 0", "approve"],
    ["/done", "done"],
    ["/replan", "replan"],
  ])("returns usage for malformed %j", (text, name) => {
    expect(parseCommand(text)).toMatchObject({ ok: false, name });
  });

  it.each(["lol see you at 9", "/shrug", "a /trip in the middle", ""])("ignores non-commands %j", (text) => {
    expect(parseCommand(text)).toBeNull();
  });
});
