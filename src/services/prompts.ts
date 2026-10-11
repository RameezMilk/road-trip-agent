import { formatDuration, formatTime } from "../domain/time";
import type { Itinerary, ResolvedRequirements } from "../schemas";

// System prompts for each Gemini task. Facts (distances, times, fuel, CO₂) never come from these calls.

export const SYSTEM = {
  predefinedExtraction: `You extract road-trip requirements from one traveler's text message.
Fill only fields the message actually states; use null for everything else.
- Locations: "City, ST" (or a specific landmark/address if they gave one).
- Dates: YYYY-MM-DD. Resolve relative dates ("next Saturday", "this weekend") against today's date given below. If they give a single day trip, startDate = endDate.
- tripType: "round_trip" or "one_way".
- budgetPerPersonUsd: number in US dollars per person for the whole trip.
- dietaryRestrictions: short items like "halal", "vegetarian", "peanut allergy"; [] if they say they have none.`,

  optionalExtraction: `You extract a traveler's extra road-trip wishes as short standalone requirements (at most 12 words each),
e.g. "Halal food at meals", "At least 5 rest stops", "Visit a waterfall", "No driving after 9pm".
Return at most 5. Return an empty list if the message contains no wish (e.g. greetings or questions).`,

  conflictAnalysis: `You coordinate a group road trip. You get the group's anonymous optional requirements.
Adopt every requirement that can be satisfied together with the others (put its id in adoptedRequirementIds).
Only where requirements genuinely cannot all be met equally (they compete for the same time, money or stop), create a poll.
Bundle related conflicts into one high-level choice; create at most 3 polls. Each option:
- label: short choice shown to voters (no names, it is anonymous),
- requirementIds: the requirements that option satisfies,
- resolution: the requirement text the planner will follow if it wins.
If nothing conflicts, return polls: [].`,

  voteMapping: `Map a voter's free-text reply to the closest poll option id.
Return null if the reply does not express a preference among the options.`,

  itineraryDraft: (
    maxStops: number,
  ) => `You are the planning engine of a group road-trip agent. Use Google Search to find real places that are currently open.
Return JSON matching the schema. Rules:
- Follow the group's requirements exactly: route, dates, trip type, budget per person and EVERY dietary restriction (every restaurant must work for all of them).
- Honour the adopted wishes and decisions.
- Plan days 1..N where N is the number of trip days given. departTime is the local HH:MM departure for each day's first leg.
- List stops in driving order. Do NOT include the starting location: code adds it.
- Include exactly one stop of kind "destination" for the end location when the group arrives there. For round trips that is the turnaround point; code adds the drive home.
- Multi-day trips: end every day except the last with a "lodging" stop.
- Include meal stops at sensible times, a "gas" stop roughly every 250 miles, and "rest_stop"s on long stretches.
- At most ${maxStops} stops in total; fewer is fine for short trips.
- addressQuery: a street address, or "Place name, City, ST", that OpenStreetMap can find. city: "City, ST".
- dwellMinutes: time spent at the stop.
- sustainable: true for low-carbon activities (parks, hikes, walking tours, farm-to-table, local markets, EV charging).
- estCostPerPersonUsd: rough per-person cost from your research, or null. sourceUrl: the page you used, or null.
- Never state distances or drive times; code computes them from real routing.`,

  feedbackAssessment: `A member of a road-trip group sent feedback on the proposed itinerary. Classify its impact:
- "minor": a small tweak that keeps everyone's preferences and does not materially change schedule, budget or driving time (e.g. swap a restaurant for a similar one, 15 more minutes somewhere).
- "material": changes someone's preferences or materially alters the schedule (30+ minutes), budget or driving time.
- "conflicting": clashes with another member's stated requirement or a group decision, or is a significant tradeoff the group should vote on.
summary: one neutral line describing the requested change (no names).
instruction: a precise instruction for the replanner.
For "conflicting" only: pollQuestion and 2–3 pollOptions, each with the replanner instruction it implies. Do not include a "keep the current plan" option; code adds it.`,

  liveUpdate: `The group is on their road trip right now. Classify one member's message:
- "delay": they are running late or stayed longer somewhere. delayMinutes if stated (else null), stopId = the stop where they are delayed (usually the current stop).
- "replace_stop": swap one specific planned stop for something else. stopId + request (what they want instead).
- "replan_remaining": a broader change to the rest of the plan. request.
- "none": a question or chit-chat. reply: a short helpful answer based on the itinerary.
If the message answers the agent's previous question in the recent conversation, combine them into one intent
(e.g. the member asked to swap a restaurant for a cheaper one, the agent asked which, the member says "Gypsy Queen"
→ replace_stop with that stop's id and request "a cheaper restaurant"). Ask a clarifying question only if still ambiguous.`,

  replacementStop: `You replace one stop on a road trip with a real place found via Google Search.
The new place must satisfy the request and every dietary restriction, be near the given location and fit between the previous and next stops.
Same JSON rules as the itinerary planner (addressQuery findable on OpenStreetMap, city "City, ST").
summary: one line describing the swap.`,
};

export function requirementsBlock(r: ResolvedRequirements, days: number): string {
  return [
    `Start: ${r.startLocation}`,
    `End: ${r.endLocation}`,
    `Trip type: ${r.tripType === "round_trip" ? "round trip (return to start on the last day)" : "one way"}`,
    `Dates: ${r.startDate} to ${r.endDate} (${days} day${days === 1 ? "" : "s"})`,
    `Budget: $${r.budgetPerPersonUsd} per person for the whole trip`,
    `Dietary restrictions (apply to the whole group): ${r.dietaryRestrictions.length ? r.dietaryRestrictions.join(", ") : "none"}`,
    `Adopted wishes: ${r.adopted.length ? r.adopted.map((a) => `[${a.category}] ${a.text}`).join("; ") : "none"}`,
    `Group decisions: ${r.decisions.length ? r.decisions.map((d) => `${d.question} → ${d.winningLabel}`).join("; ") : "none"}`,
  ].join("\n");
}

/** Compact itinerary for prompts: one line per stop with its id and times. */
export function itineraryBlock(it: Itinerary): string {
  const lines = it.stops.map((s) => {
    const at = s.arriveAt ? formatTime(s.arriveAt, it.timeZone) : "start";
    const leave = s.departAt ? formatTime(s.departAt, it.timeZone) : "end";
    return `- [${s.id}] day ${s.day} ${s.kind} "${s.name}" ${s.address ?? ""} arrive ${at}, leave ${leave}, ${s.dwellMinutes} min`;
  });
  return [
    `Itinerary v${it.version}: ${it.startLocation} → ${it.endLocation}, ${formatDuration(it.totals.driveSeconds)} driving`,
    ...lines,
  ].join("\n");
}

/** Recent DM exchange for follow-up context ("Gypsy Queen" answering the agent's "which restaurant?"). */
export function conversationBlock(turns: Array<{ direction: "inbound" | "outbound"; text: string }>): string {
  if (turns.length === 0) return "";
  const lines = turns.map((t) => `${t.direction === "inbound" ? "Member" : "Agent"}: ${t.text.replace(/\s+/g, " ")}`);
  return `Recent conversation with this member (oldest first) — the new message may answer the agent's last question:\n${lines.join("\n")}\n\n`;
}
