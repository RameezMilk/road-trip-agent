import { METERS_PER_MILE } from "../domain/geo";
import type { PredefinedReconciliation } from "../domain/reconcile";
import { datesLabel, routeLabel } from "../domain/reconcile";
import { formatDuration, formatLocalDate, formatTime } from "../domain/time";
import type { Itinerary, Poll, PredefinedField, StopKind, Trip } from "../schemas";

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

export const FIELD_QUESTIONS: Record<PredefinedField, string> = {
  startLocation: "📍 Where are you starting from? (a city or an address)",
  endLocation: "🏁 Where do you want to end up?",
  startDate: "📅 What day do you want to leave? (e.g. Oct 17)",
  endDate: "📅 And what day should the trip end?",
  tripType: "🔁 Round trip or one way?",
  budgetPerPersonUsd: "💵 What's your budget per person for the whole trip, in USD?",
  dietaryRestrictions: "🥗 Any dietary restrictions? (e.g. halal, vegetarian — or “none”)",
};

/** How long someone has waited, for reminders: "40 sec", "4 min", "1 hr 5 min". */
export function formatWaited(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} hr${rest ? ` ${rest} min` : ""}`;
}

/** "A", "A and B", "A, B and C". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const masked = (handle: string) =>
  handle.includes("@") ? handle.replace(/^(.).*(@.*)$/, "$1…$2") : `…${handle.slice(-4)}`;

export const copy = {
  welcome: () =>
    "👋 Hi! I'm your Road Trip Agent — I plan group road trips right here in iMessage.\n\nText `newtrip` to start one (you'll be the host), or ask a friend to invite this number.",
  pendingInvite: (trip: Trip, hostName: string) =>
    `👋 ${hostName} invited you to plan “${trip.title}”. Reply \`join\` to hop in!`,
  noInvite: () =>
    "I couldn't find an invite for this number. Ask your host to `invite` you, or text `join CODE` with their trip code.",
  badCode: () => "That trip code doesn't match an open trip. Double-check it with your host.",
  alreadyInTrip: (trip: Trip) =>
    `You're already in “${trip.title}”. The host can text \`cancel\` to end it before starting a new one.`,
  tripCreated: (trip: Trip) =>
    `🚗 New trip “${trip.title}” created — you're the host!\n\nFirst, what's your first name?`,
  askName: () => "What's your first name? (That's what the group will see.)",
  badName: () => "Just your first name, please — something like “Sam”.",
  hostNext: (name: string, trip: Trip) =>
    `Nice to meet you, ${name}! Invite your crew:\n\`invite +19195551234, +19845550000\`\n\nOr share trip code *${trip.inviteCode}* — friends text \`join ${trip.inviteCode}\`.\n\n(Each friend's number must be added in the Photon dashboard first.) When everyone's in, everyone replies \`ready\`.`,
  joined: (trip: Trip) => `🎉 You're in “${trip.title}”! What's your first name?`,
  memberNext: (name: string) => `Thanks, ${name}! Reply \`ready\` when you're set to start planning.`,
  someoneJoined: (name: string, joined: number, total: number) => `👋 ${name} joined the trip (${joined}/${total} in).`,
  invitation: (hostName: string, trip: Trip) =>
    `👋 ${hostName} invited you to plan a road trip: “${trip.title}”.\nReply \`join\` to accept.`,
  inviteReport: (sent: string[], failed: string[], already: string[]) =>
    [
      sent.length ? `✉️ Invited ${sent.map(masked).join(", ")}.` : "",
      already.length ? `Already on the trip: ${already.map(masked).join(", ")}.` : "",
      failed.length
        ? `⚠️ I can't message ${failed.map(masked).join(", ")} yet — add them in the Photon dashboard, then invite again.`
        : "",
      sent.length ? "When everyone has joined, everyone replies `ready`." : "",
    ]
      .filter(Boolean)
      .join("\n"),
  hostOnly: () => "Only the trip host can do that.",
  needName: () => "First things first — what's your first name?",
  onboardingHint: (isHost: boolean) =>
    isHost
      ? "Invite friends with `invite +1…`, then everyone replies `ready`. Text `status` to see who's in."
      : "Reply `ready` when you're set to start planning. Text `status` to see who's in.",
  waitingToStart: (waiting: string[]) => `✅ You're ready! Waiting on: ${waiting.join(", ")}.`,
  someoneReady: (name: string, ready: number, total: number) => `✅ ${name} is ready (${ready}/${total}).`,
  waitingOnInvite: (handle: string) => `${masked(handle)} (hasn't joined)`,
  needMoreMembers: (min: number) => `at least ${min} travelers`,

  planningIntro: () =>
    "🗺️ Everyone's in — planning time! I'll ask a few must-know questions first. Answer in your own words; you can answer several at once.",
  question: (field: PredefinedField) => FIELD_QUESTIONS[field],
  captured: (fields: PredefinedField[]) => `👍 Got your ${fields.map((f) => FIELD_LABELS[f]).join(", ")}.`,
  didntCatch: (field: PredefinedField) => `Hmm, I didn't catch your ${FIELD_LABELS[field]}.`,
  predefinedDone: (recap: string) =>
    `✨ Must-haves saved:\n${recap}\n\nAnything else you'd love on this trip? Food, stops, activities, pace — send as many messages as you like (e.g. “halal food”, “5 rest stops”, “a waterfall hike”).\n\nReply \`ready\` when you're done.`,
  updated: (recap: string) => `✏️ Updated:\n${recap}`,
  optionalNoted: (items: string[]) => `📝 Noted: ${items.join("; ")}. Anything else? Reply \`ready\` when you're done.`,
  optionalNothing: () => "Got it. Anything else you'd like on the trip? Reply `ready` when you're done.",
  stillMissing: (fields: PredefinedField[]) =>
    `I still need your ${fields.map((f) => FIELD_LABELS[f]).join(", ")} before you can ready up.`,
  youreReady: (ready: number, total: number) =>
    `✅ You're all set (${ready}/${total} ready). I'll text you when it's time to vote.`,

  settled: (rec: PredefinedReconciliation, pollCount: number) =>
    [
      "🧮 Everyone's ready! Here's what's settled:",
      rec.route.kind === "agreed" ? `• Route: ${routeLabel(rec.route.value)}` : "",
      rec.dates.kind === "agreed" ? `• Dates: ${datesLabel(rec.dates.value)}` : "",
      `• Budget: $${rec.budgetPerPersonUsd}/person (the lowest anyone said, so everyone can afford it)`,
      `• Dietary: ${rec.dietaryRestrictions.length ? rec.dietaryRestrictions.join(", ") : "no restrictions"}`,
      pollCount ? `\nSome answers differ, so let's vote (${pollCount} quick poll${pollCount === 1 ? "" : "s"}).` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  pollText: (poll: Poll, revote: boolean) =>
    [
      revote ? `🔁 It's a tie — quick revote: ${poll.question}` : `🗳️ Vote: ${poll.question}`,
      ...poll.options.map((o, i) => `${i + 1}. ${o.label}`),
      "",
      "Reply with a number, or tell me in your own words.",
    ].join("\n"),
  voteCounted: (label: string, cast: number, total: number) => `🗳️ Counted: ${label} (${cast}/${total} votes in).`,
  voteUnclear: (n: number) => `I couldn't match that to an option — reply with a number from 1 to ${n}.`,
  pollResult: (question: string, label: string, votes: number, voters: number) =>
    `📊 ${question} → *${label}* (${votes} of ${voters} vote${voters === 1 ? "" : "s"}).`,
  noOpenPoll: () => "No vote is open right now — hang tight!",
  aborted: (question: string) =>
    `🛑 We couldn't agree on “${question}”, even after a revote. Please talk it through in person — then the host can text \`newtrip\` to start fresh.`,
  conflictCheckFailed: () => "(I couldn't check everyone's extra wishes for conflicts, so I kept them all.)",
  optionalAdopted: (n: number) => `✅ ${n} extra wish${n === 1 ? "" : "es"} fit together nicely — no vote needed.`,

  drafting: (revising: boolean) =>
    revising
      ? "🧭 Updating the itinerary with live web search… (about a minute)"
      : "🧭 Drafting your itinerary with live web search… (about a minute)",
  stillDrafting: () => "🧭 Still drafting — hang tight!",
  retryingDraft: () => "🔄 Retrying the itinerary draft now…",
  draftFailed: (reason: string, hasVersion: boolean) =>
    hasVersion
      ? `⚠️ I couldn't apply that change (${reason}). The current plan still stands.`
      : `⚠️ I hit a snag drafting the itinerary (${reason}). Text me anything to retry.`,
  reviewAsk: () => "Reply `approve` if it looks good, or tell me what to change.",
  revisedHeader: (version: number, note: string | null, diff: string) =>
    [`✏️ Updated itinerary (v${version})${note ? ` — ${note}` : ""}`, diff].join("\n"),
  approved: (approved: number, total: number) => `✅ Approved (${approved}/${total}).`,
  someoneApproved: (name: string, version: number, approved: number, total: number) =>
    `✅ ${name} approved v${version} (${approved}/${total}).`,
  minorAck: () => "👍 Small tweak — applying it now. Everyone's approvals still count.",
  materialAck: () => "That changes the plan for everyone, so I'll draft a new version and ask everyone to re-approve.",
  conflictAck: (summary: string) => `That clashes with what others asked for, so let's vote on it: ${summary}`,
  keepCurrent: (version: number) => `👌 The group chose to keep the current plan (v${version}).`,
  approvedAll: () =>
    "🎉 Everyone approved! Here's your trip dashboard 👇\n\nOn the road, text me changes like “we're running 30 min late” or “sushi instead of pizza tomorrow” and I'll update everyone.",
  onTheRoad: () => "You're on the road! 🚗 Text me any change and I'll update the plan for everyone.",
  noDashboardYet: () => "There's no itinerary yet — I'll send the dashboard once one exists.",
  dashboardUnavailable: () => "The dashboard link isn't set up yet (PUBLIC_BASE_URL is missing).",
  liveApplied: (name: string, header: string, diff: string) =>
    `🔄 ${name}: ${header}\n${diff}\n\nThe dashboard is updated.`,
  askDelay: () => "How many minutes behind are you?",
  askWhichStop: () => "Which stop should I change?",
  working: () => "On it… 🔎",
  couldNot: (reason: string) => `⚠️ I couldn't do that: ${reason}`,
  oops: () => "😵 Something went wrong on my side. Try again in a moment.",
  tripCancelled: (trip: Trip) => `🛑 The host cancelled “${trip.title}”. Text \`newtrip\` to start a new one.`,
  tripAborted: (trip: Trip) =>
    `This trip ended${trip.abortReason ? ` (${trip.abortReason})` : ""}. Text \`newtrip\` to start a new one.`,
  textOnly: () => "I can only read text messages for now — mind typing that out?",
  photoLooking: () => "📸 Got it — taking a look…",
  photoWish: (description: string, wish: string) => `📸 ${description}. Added to your wishes: “${wish}”.`,
  photoScene: (description: string, wish: string) =>
    `📸 ${description}. I'll look for stops like that — added to your wishes: “${wish}”.`,
  photoSeen: (description: string) => `📸 ${description}.`,
  photoUnclear: () =>
    "📸 I couldn't spot a place or a kind of stop in that picture. Send a screenshot of the post, or a photo of the kind of spot you'd like.",
  photoNotNow: () =>
    "📸 I can use photos while we're planning or reviewing the itinerary — for now, mind typing it out?",
  photoUnreadable: () => "📸 I couldn't open that picture. Mind sending it again?",
  sendThePhoto: () => "📸 Send the picture and I'll work it in.",
  photoAnythingElse: () => "Anything else? Reply `ready` when you're done.",
  reminder: (name: string | null, waiting: Array<{ name: string; waitedMs: number }>, ask: string) => {
    const head = waiting.length
      ? `⏰ Hey${name ? ` ${name}` : ""} — ${nameList(waiting.map((w) => w.name))} ${waiting.length === 1 ? "is" : "are"} waiting on you to respond (${waiting.map((w) => `${w.name} for ${formatWaited(w.waitedMs)}`).join(", ")}).`
      : `⏰ Hey${name ? ` ${name}` : ""} — the trip is waiting on your reply.`;
    return `${head}\n${ask}`;
  },
};

export function formatItinerary(it: Itinerary): string {
  const miles = Math.round(it.totals.distanceMeters / METERS_PER_MILE);
  const lines: string[] = [
    `🗺️ ${it.title} (v${it.version})`,
    `${it.startLocation} → ${it.endLocation} · ${miles} mi · ${formatDuration(it.totals.driveSeconds)} driving${it.routeSource === "osrm" ? "" : " (estimated)"}`,
  ];
  let day = 0;
  for (const s of it.stops) {
    if (s.day !== day) {
      day = s.day;
      const date = (s.departAt ?? s.arriveAt ?? "").slice(0, 10);
      lines.push("", `📅 Day ${day}${date ? ` · ${formatLocalDate(date)}` : ""}`);
    }
    const at = s.arriveAt ?? s.departAt;
    const time = at ? formatTime(at, it.timeZone) : "";
    const dwell = s.dwellMinutes && s.departAt && s.arriveAt && s.kind !== "lodging" ? ` · ${s.dwellMinutes} min` : "";
    lines.push(
      `${time} ${STOP_ICONS[s.kind]} ${s.name}${dwell}${s.geocodeSource === "approximate" ? " (approx. location)" : ""}`,
    );
  }
  const t = it.totals;
  const su = it.sustainability;
  lines.push(
    "",
    `💵 ~$${t.estimatedCostPerPersonUsd}/person (fuel $${t.fuelCostPerPersonUsd} + web-estimated stops $${t.webEstimateStopCostPerPersonUsd}) · budget $${t.budgetPerPersonUsd}${t.overBudget ? " ⚠️ over budget" : ""}`,
    `🌱 Carpooling saves ${su.gallonsSavedByCarpool} gal ($${su.usdSavedByCarpool}) vs. everyone driving alone · ${su.greenStops}/${su.totalStops} green stops`,
  );
  if (it.droppedStops.length) lines.push(`⚠️ Couldn't locate: ${it.droppedStops.join(", ")}`);
  return lines.join("\n");
}
