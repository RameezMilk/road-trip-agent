import type { PredefinedReconciliation } from "../domain/reconcile";
import { datesLabel, routeLabel } from "../domain/reconcile";
import { formatLocalDate } from "../domain/time";
import type { Poll, PredefinedField, StopKind, Trip } from "../schemas";

// Every message the agent sends lives here, so tone and wording stay consistent.

export const STOP_ICONS: Record<StopKind, string> = {
  origin: "🏠",
  destination: "🏁",
  restaurant: "🍽️",
  gas: "⛽",
  rest_stop: "🚻",
  lodging: "🏨",
  scenic: "🏞️",
  attraction: "🎟️",
  charging: "⚡",
};

export const FIELD_LABELS: Record<PredefinedField, string> = {
  startLocation: "starting point",
  endLocation: "destination",
  startDate: "start date",
  endDate: "end date",
  tripType: "trip type",
  budgetPerPersonUsd: "budget per person",
  dietaryRestrictions: "dietary restrictions",
};

/** Follow-ups when one field of a grouped question is still missing. */
export const FIELD_QUESTIONS: Record<PredefinedField, string> = {
  startLocation: "📍 Where are you starting from?",
  endLocation: "🏁 And where to?",
  startDate: "📅 What day do you leave?",
  endDate: "📅 What day do you get back?",
  tripType: "🔁 Round trip or one way?",
  budgetPerPersonUsd: "💵 Budget per person? e.g. $300",
  dietaryRestrictions: "🥗 Any dietary needs? e.g. halal — or none",
};

/** The three grouped planning questions (7 must-haves). */
export type PlanningStep = "route" | "dates" | "budgetDiet";
export const STEP_QUESTIONS: Record<PlanningStep, string> = {
  route: "📍 Where from, and where to?\ne.g. Chapel Hill to Wilmington",
  dates: "📅 When? e.g. Oct 18–19",
  budgetDiet: "💵 Budget per person + any dietary needs?\ne.g. $300, halal — or $250, none",
};

/** What kind of place the trip heads to; picks the send-off joke. */
export const VIBES = ["beach", "mountains", "lake", "city", "desert", "countryside", "other"] as const;
export type Vibe = (typeof VIBES)[number];

const SEND_OFF: Record<Vibe, { emoji: string; line: string }> = {
  beach: { emoji: "🏖️", line: "Enjoy the waves — and don't forget to pack sunscreen 🧴😎" },
  mountains: { emoji: "🏔️", line: "Enjoy the views — and pack a jacket, it gets chilly up there 🧥😄" },
  lake: { emoji: "🛶", line: "Enjoy the water — and don't forget a towel 🏊‍♂️" },
  city: { emoji: "🌆", line: "Enjoy the city — and wear comfy shoes, you'll be walking a lot 👟" },
  desert: { emoji: "🌵", line: "Enjoy the sun — and bring water. Lots of water 💧😅" },
  countryside: { emoji: "🌾", line: "Enjoy the open road — and queue up a good playlist 🎶" },
  other: { emoji: "🚗", line: "Enjoy the ride — and queue up a good playlist 🎶" },
};

const masked = (handle: string) =>
  handle.includes("@") ? handle.replace(/^(.).*(@.*)$/, "$1…$2") : `…${handle.slice(-4)}`;

/** 1 → "1️⃣" (keycap emoji, up to 9). */
const keycap = (n: number) => (n >= 1 && n <= 9 ? `${n}\uFE0F\u20E3` : `${n}.`);
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export const copy = {
  // --- onboarding ---------------------------------------------------------------------------------
  welcome: () =>
    "👋 I plan group road trips right here in iMessage.\n• Text `newtrip` to start one\n• Got a code? Text `join CODE`",
  pendingInvite: (_trip: Trip, hostName: string) =>
    `👋 ${hostName} invited you on a road trip! Reply \`join\` to hop in.`,
  noInvite: () =>
    "🤔 No invite for this number yet.\n• Got a code? Text `join CODE`\n• Or text `newtrip` to start your own",
  badCode: () => "🤔 That code doesn't match an open trip — double-check it with your friend.",
  alreadyInTrip: (trip: Trip) => `You're already in “${trip.title}”. (The host can text \`cancel\` to end it.)`,
  tripCreated: () => "🚗 Trip started! Send the join message to your friends to join the trip!",
  joinMessage: (trip: Trip) => `join ${trip.inviteCode}`,
  askName: () => "What's your first name?",
  badName: () => "Just your first name, please — like “Sam”.",
  hello: (name: string, question: string) => `Hey ${name}! ${question}`,
  joined: (hostName: string | null) => `🎉 You're in${hostName ? ` ${hostName}'s trip` : ""}! What's your first name?`,
  /** A joiner whose name Photon already knows: straight into their first question. */
  joinedNamed: (name: string, hostName: string | null, question: string) =>
    `🎉 You're in${hostName ? ` ${hostName}'s trip` : ""}, ${name}!\n${question}`,
  someoneJoined: (name: string) => `👋 ${name} joined!`,
  invitation: (hostName: string, _trip: Trip) => `👋 ${hostName} invited you on a road trip! Reply \`join\` to hop in.`,
  inviteReport: (sent: string[], failed: string[], already: string[]) =>
    [
      sent.length ? `✉️ Invited ${sent.map(masked).join(", ")}` : "",
      already.length ? `• Already in: ${already.map(masked).join(", ")}` : "",
      failed.length ? `⚠️ Can't message ${failed.map(masked).join(", ")} — add them in the Photon dashboard first` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  hostOnly: () => "Only the trip host can do that.",
  needName: () => "First things first — what's your first name?",
  // Legacy onboarding-phase trips (created before planning-first trips).
  hostNext: (name: string, trip: Trip) =>
    `Nice to meet you, ${name}! Friends text \`join ${trip.inviteCode}\`. When everyone's in, reply \`ready\`.`,
  memberNext: (name: string) => `Thanks, ${name}! Reply \`ready\` when you're set.`,
  onboardingHint: (isHost: boolean) =>
    isHost ? "Friends join with the trip code, then everyone replies `ready`." : "Reply `ready` when you're set.",
  waitingToStart: (waiting: string[]) => `✅ You're ready! Waiting on ${waiting.join(", ")}.`,
  someoneReady: (name: string, ready: number, total: number) => `✅ ${name} is ready (${ready}/${total})`,
  waitingOnInvite: (handle: string) => `${masked(handle)} (invited)`,
  needMoreMembers: () => "a friend to join",

  // --- planning -----------------------------------------------------------------------------------
  planningIntro: () => "🗺️ Planning time — 3 quick questions.",
  stepQuestion: (step: PlanningStep) => STEP_QUESTIONS[step],
  question: (field: PredefinedField) => FIELD_QUESTIONS[field],
  /** Guests only pick the destination; the host's starting point is shared. */
  guestRoute: (start: string | null) => `📍 Where to? e.g. Asheville${start ? `\n(leaving from ${start})` : ""}`,
  didntCatch: () => "🤔 Didn't catch that.",
  datePassed: (date: string) => `${formatLocalDate(date)} has passed — pick a future date.`,
  endBeforeStart: () => "The end date is before the start date.",
  askWish: () => "✨ Anything else you'd love? e.g. beach day, seafood — or “nope”",
  updated: (recap: string) => `✏️ Updated:\n${recap}`,
  wishAdded: (items: string[]) => `📝 Added: ${items.join("; ")}`,
  wishNothing: () => "👍 Got it — I'll ping you when it's time to vote.",
  stillCollecting: () => "Still collecting everyone's answers — hang tight!",
  stillMissing: (fields: PredefinedField[]) => `I still need your ${fields.map((f) => FIELD_LABELS[f]).join(", ")}.`,
  allSet: (recap: string, waiting: string[]) =>
    [`✅ You're all set!`, recap, waiting.length ? `⏳ Waiting on ${waiting.join(", ")}…` : ""]
      .filter(Boolean)
      .join("\n"),

  // --- voting -------------------------------------------------------------------------------------
  settled: (rec: PredefinedReconciliation, pollCount: number, wishes: string[] = []) =>
    [
      "🧮 Everyone's in! Settled:",
      rec.route.kind === "agreed" ? `• 📍 ${routeLabel(rec.route.value)}` : "",
      rec.dates.kind === "agreed" ? `• 📅 ${datesLabel(rec.dates.value)}` : "",
      `• 💵 $${rec.budgetPerPersonUsd}/person (lowest budget)`,
      `• 🥗 ${rec.dietaryRestrictions.length ? rec.dietaryRestrictions.join(", ") : "no restrictions"}`,
      wishes.length ? `• ✨ ${wishes.join("; ")}` : "",
      pollCount ? "Quick vote 👇" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  pollText: (poll: Poll, revote: boolean) =>
    [
      revote ? `🔁 Tie! Revote: ${poll.question}` : `🗳️ ${poll.question}`,
      ...poll.options.map((o, i) => `${keycap(i + 1)} ${o.label}`),
      "Reply with a number",
    ].join("\n"),
  voteCounted: (label: string, cast: number, total: number) => `🗳️ Got it: ${label} (${cast}/${total} in)`,
  voteUnclear: (n: number) => `🤔 Reply with a number from 1 to ${n}.`,
  pollResult: (_question: string, label: string, votes: number, voters: number) =>
    `📊 ${label} wins! (${votes}/${voters})`,
  noOpenPoll: () => "No vote is open right now — hang tight!",
  aborted: (question: string) =>
    `🛑 Couldn't agree on “${question}”, even after a revote.\n• Talk it over in person\n• Then the host can text \`newtrip\``,
  conflictCheckFailed: () => "(Couldn't check everyone's wishes for conflicts, so I kept them all.)",
  optionalAdopted: (n: number) => `✨ ${plural(n, "wish", "wishes")} fit together — no vote needed.`,

  // --- drafting & review --------------------------------------------------------------------------
  drafting: (revising: boolean) =>
    revising ? "🧭 Updating the plan with live web search…" : "🧭 Planning your trip with live web search…",
  stillDrafting: () => "🧭 Still planning — hang tight!",
  retryingDraft: () => "🔄 Retrying the plan now…",
  draftFailed: (reason: string, hasVersion: boolean) =>
    hasVersion
      ? `⚠️ Couldn't apply that change (${reason}). The current plan stands.`
      : `⚠️ Hit a snag planning (${reason}). Text me anything to retry.`,
  itineraryReady: () => "✅ Itinerary ready!",
  /** "Wilmington, NC" → "🏖️ You're set for Wilmington!" plus a line that fits the place. */
  sendOff: (vibe: Vibe, destination: string) =>
    `${SEND_OFF[vibe].emoji} You're set for ${destination.split(",")[0]?.trim() || destination}!\n${SEND_OFF[vibe].line}`,
  reviewAsk: () => "Reply `approve` 👍 or tell me what to change.",
  revisedHeader: (version: number, note: string | null, diff: string) =>
    [`✏️ Plan updated (v${version})${note ? ` — ${note}` : ""}`, diff].join("\n"),
  approved: (approved: number, total: number) => `✅ Approved (${approved}/${total})`,
  someoneApproved: (name: string, _version: number, approved: number, total: number) =>
    `✅ ${name} approved (${approved}/${total})`,
  minorAck: () => "👍 Small tweak — applying it now. Approvals still count.",
  materialAck: () => "✏️ That changes the plan for everyone — drafting a new version to re-approve.",
  conflictAck: (summary: string) => `⚖️ That clashes with what others asked for — let's vote: ${summary}`,
  keepCurrent: (version: number) => `👌 Keeping the current plan (v${version}).`,
  approvedAll: () => "🎉 Everyone approved!",
  onTheRoad: () => "🚗 You're on the road! Text me any change — e.g. “running 30 min late”.",
  noDashboardYet: () => "No itinerary yet — the dashboard comes with it.",
  dashboardUnavailable: () => "The dashboard link isn't set up (PUBLIC_BASE_URL is missing).",
  liveApplied: (name: string, header: string, diff: string) => `🔄 ${name}: ${header}\n${diff}\n🗺️ Dashboard updated`,
  askDelay: () => "⏱️ How many minutes behind are you?",
  askWhichStop: () => "Which stop should I change?",
  working: () => "On it… 🔎",
  couldNot: (reason: string) => `⚠️ Couldn't do that: ${reason}`,
  oops: () => "😵 Something went wrong on my side. Try again in a moment.",
  tripCancelled: (trip: Trip) => `🛑 The host cancelled “${trip.title}”. Text \`newtrip\` to start a new one.`,
  tripAborted: (trip: Trip) =>
    `This trip ended${trip.abortReason ? ` (${trip.abortReason})` : ""}. Text \`newtrip\` to start a new one.`,
  textOnly: () => "I can only read text for now — mind typing that out?",
};
