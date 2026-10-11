import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { diffItineraries, formatDiff } from "../../domain/diff";
import { currentStopIndex, finalizeItinerary, shiftSchedule } from "../../domain/schedule";
import { formatTime } from "../../domain/time";
import { type Itinerary, type LiveUpdate, liveUpdateSchema, type Trip } from "../../schemas";
import { PlanningError } from "../../services/planner";
import { conversationBlock, itineraryBlock, SYSTEM } from "../../services/prompts";
import { copy, VIBES, type Vibe } from "../copy";
import type { Ctx, Engine } from "../engine";

/**
 * The first itinerary is in and the trip starts: each member gets "✅ Itinerary ready!", the dashboard
 * card, a send-off that fits the destination, and the dap GIF. Members are served in parallel (so both
 * phones light up together), in that order within each thread.
 */
export async function launch(e: Engine, trip: Trip, itinerary: Itinerary): Promise<void> {
  const vibe = destinationVibe(e, trip, itinerary);
  const gif = await gifPath(e);
  await Promise.all(
    (await e.joinedMembers(trip.id)).map(async (m) => {
      const to = e.recipient(m);
      await e.sendTo(to, copy.itineraryReady());
      if (e.dashboardUrl(trip)) await e.upsertCard(trip, m, itinerary, true);
      else await e.sendTo(to, copy.dashboardUnavailable());
      await e.sendTo(to, copy.sendOff(await vibe, itinerary.endLocation));
      if (gif) await e.sendFile(to, gif, "image/gif");
    }),
  );
}

/** review → execution (REVIEW_STEP on): everyone approved the version they already have on their card. */
export async function begin(e: Engine, tripId: string): Promise<void> {
  if (!(await e.repo.transition(tripId, "review", "execution"))) return;
  const trip = await e.repo.getTrip(tripId);
  const itinerary = trip ? await e.currentItinerary(trip) : null;
  if (!trip || !itinerary) return;
  const vibe = destinationVibe(e, trip, itinerary);
  const gif = await gifPath(e);
  await Promise.all(
    (await e.joinedMembers(tripId)).map(async (m) => {
      const to = e.recipient(m);
      await e.sendTo(to, copy.approvedAll());
      if (!m.card) await e.upsertCard(trip, m, itinerary);
      await e.sendTo(to, copy.sendOff(await vibe, itinerary.endLocation));
      if (gif) await e.sendFile(to, gif, "image/gif");
    }),
  );
}

/** Beach, mountains, city…: one fast OpenAI Decisions call (no Decider → the generic line). */
async function destinationVibe(e: Engine, trip: Trip, itinerary: Itinerary): Promise<Vibe> {
  const decided = await e.decider.choose({
    name: "destination_vibe",
    instructions: "What kind of place is this road trip headed to? Pick what best describes the destination.",
    evidence: [
      `Destination: ${itinerary.endLocation}`,
      `Stops: ${itinerary.stops.map((s) => s.name).join(", ")}`,
      trip.resolved?.adopted.length ? `Wishes: ${trip.resolved.adopted.map((a) => a.text).join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    choices: VIBES.map((v) => ({ value: v, description: v === "other" ? "None of these" : `A ${v} destination` })),
  });
  return decided && decided.confidence >= 0.4 ? (decided.value as Vibe) : "other";
}

async function gifPath(e: Engine): Promise<string | null> {
  const configured = e.config.dapGifPath;
  if (!configured) return null;
  const path = resolve(configured);
  try {
    await access(path);
    return path;
  } catch {
    e.log("send_off_gif_missing", { path });
    return null;
  }
}

export async function sendDashboard(e: Engine, ctx: Ctx): Promise<void> {
  const itinerary = await e.currentItinerary(ctx.trip);
  if (!itinerary) return void (await e.reply(ctx, copy.noDashboardYet()));
  if (!e.dashboardUrl(ctx.trip)) return void (await e.reply(ctx, copy.dashboardUnavailable()));
  await e.upsertCard(ctx.trip, ctx.member, itinerary, true);
}

export async function handle(e: Engine, ctx: Ctx): Promise<void> {
  if (ctx.command) return void (await e.reply(ctx, copy.onTheRoad()));
  const itinerary = await e.currentItinerary(ctx.trip);
  if (!itinerary || !ctx.trip.resolved) return;
  const now = e.clock();
  const current = itinerary.stops[currentStopIndex(itinerary, now)];
  const ids = itinerary.stops.map((s) => s.id) as [string, ...string[]];

  const history = await e.repo.recentConversation(ctx.member.id, ctx.msg.messageId).catch(() => []);
  let intent: LiveUpdate;
  try {
    intent = await e.llm.generate({
      task: "live_update",
      system: SYSTEM.liveUpdate,
      prompt: `Now: ${formatTime(now.toISOString(), itinerary.timeZone)} on ${e.todayIn(itinerary.timeZone)}.\nCurrent stop: [${current?.id}] ${current?.name}\n\n${itineraryBlock(itinerary)}\n\n${conversationBlock(history)}Message: """${ctx.msg.text}"""`,
      schema: liveUpdateSchema(ids),
    });
  } catch (error) {
    e.log("live_update_failed", { error: String(error) });
    return void (await e.reply(ctx, copy.couldNot("I couldn't understand that change right now")));
  }

  try {
    switch (intent.kind) {
      case "delay":
        return await delay(e, ctx, itinerary, intent, now);
      case "replace_stop":
        return await replaceStop(e, ctx, itinerary, intent);
      case "replan_remaining":
        return await replanRemaining(e, ctx, itinerary, intent.request ?? ctx.msg.text);
      case "none":
        return void (await e.reply(ctx, intent.reply ?? copy.onTheRoad()));
    }
  } catch (error) {
    if (!(error instanceof PlanningError)) throw error;
    await e.reply(ctx, copy.couldNot(error.message));
  }
}

async function delay(e: Engine, ctx: Ctx, itinerary: Itinerary, intent: LiveUpdate, now: Date): Promise<void> {
  const stop = itinerary.stops.find((s) => s.id === intent.stopId) ?? itinerary.stops[currentStopIndex(itinerary, now)];
  if (!stop) return;
  let minutes = intent.delayMinutes;
  if (minutes === null && stop.departAt) minutes = Math.round((now.getTime() - Date.parse(stop.departAt)) / 60_000);
  if (!minutes || minutes <= 0) return void (await e.reply(ctx, copy.askDelay()));
  minutes = Math.min(600, minutes);
  const next = finalizeItinerary({
    ...itinerary,
    version: itinerary.version + 1,
    resolved: ctx.trip.resolved as NonNullable<Trip["resolved"]>,
    stops: shiftSchedule(itinerary, stop.id, minutes),
    memberCount: itinerary.sustainability.memberCount,
    vehicleMpg: itinerary.sustainability.vehicleMpg,
    gasPriceUsdPerGallon: itinerary.sustainability.gasPriceUsdPerGallon,
  });
  await publish(
    e,
    ctx,
    itinerary,
    next,
    `running ${minutes} min behind at ${stop.name} — pushed the rest of today back.`,
  );
}

async function replaceStop(e: Engine, ctx: Ctx, itinerary: Itinerary, intent: LiveUpdate): Promise<void> {
  if (!intent.stopId) return void (await e.reply(ctx, copy.askWhichStop()));
  await e.reply(ctx, copy.working());
  const { itinerary: next, summary } = await e.planner.replaceStop({
    itinerary,
    stopId: intent.stopId,
    request: intent.request ?? ctx.msg.text,
    resolved: ctx.trip.resolved as NonNullable<Trip["resolved"]>,
    memberCount: itinerary.sustainability.memberCount,
    version: itinerary.version + 1,
  });
  await publish(e, ctx, itinerary, next, summary || "swapped a stop.");
}

async function replanRemaining(e: Engine, ctx: Ctx, itinerary: Itinerary, request: string): Promise<void> {
  await e.reply(ctx, copy.working());
  const next = await e.planner.draft({
    tripId: ctx.trip.id,
    version: itinerary.version + 1,
    title: ctx.trip.title,
    timeZone: itinerary.timeZone,
    resolved: ctx.trip.resolved as NonNullable<Trip["resolved"]>,
    memberCount: itinerary.sustainability.memberCount,
    revision: { previous: itinerary, instruction: `${request} (Keep the stops already visited unchanged.)` },
  });
  await publish(e, ctx, itinerary, next, "updated the rest of the plan.");
}

/** Execution changes apply immediately (no re-approval) and everyone hears about them. */
async function publish(e: Engine, ctx: Ctx, previous: Itinerary, next: Itinerary, header: string): Promise<void> {
  const diff = formatDiff(diffItineraries(previous, next));
  await e.repo.saveItinerary(next, `${header}\n${diff}`);
  await e.repo.recordTripEvent(ctx.trip.id, "live_update", { version: next.version, by: ctx.member.id });
  await e.broadcast(ctx.trip.id, copy.liveApplied(e.displayName(ctx.member), header, diff));
  const trip = await e.repo.getTrip(ctx.trip.id);
  if (trip) await e.refreshCards(trip, next);
}
