import { isNoWish, parseBudgetDiet, parseRoute, tidyPlace } from "../../domain/answers";
import { parseDateRange } from "../../domain/dates";
import { datesLabel, isComplete, missingFields, tripTypeLabel } from "../../domain/reconcile";
import {
  LocalDate,
  newId,
  OptionalCategory,
  OptionalExtraction,
  Place,
  PredefinedExtraction,
  type PredefinedField,
  type PredefinedRequirements,
  RequirementText,
  Usd,
} from "../../schemas";
import { SYSTEM } from "../../services/prompts";
import { copy, FIELD_LABELS, type PlanningStep } from "../copy";
import type { Ctx, Engine } from "../engine";
import { invite } from "./onboarding";
import { begin as beginVoting } from "./voting";

/** The 7 must-haves, asked as 3 grouped questions (each answer can also cover later ones). */
const STEPS: ReadonlyArray<{ step: PlanningStep; fields: PredefinedField[] }> = [
  { step: "route", fields: ["startLocation", "endLocation", "tripType"] },
  { step: "dates", fields: ["startDate", "endDate"] },
  { step: "budgetDiet", fields: ["budgetPerPersonUsd", "dietaryRestrictions"] },
];

/** The next thing to ask: the whole group question, or just the field still missing from it. */
export function nextQuestion(reqs: PredefinedRequirements): string | null {
  const missing = missingFields(reqs);
  const group = STEPS.find((s) => s.fields.some((f) => missing.includes(f)));
  if (!group) return null;
  const open = group.fields.filter((f) => missing.includes(f));
  return open.length === group.fields.length || (group.step === "route" && open.length === 2)
    ? copy.stepQuestion(group.step)
    : copy.question(open[0] as PredefinedField);
}

/** Legacy trips that went through the onboarding `ready` gate get their first question here. */
export async function startPlanning(e: Engine, tripId: string): Promise<void> {
  for (const m of await e.joinedMembers(tripId)) {
    const question = nextQuestion(await e.repo.getPredefined(m.id));
    await e.sendTo(e.recipient(m), `${copy.planningIntro()}${question ? `\n${question}` : ""}`);
  }
}

export async function handle(e: Engine, ctx: Ctx): Promise<void> {
  if (ctx.command?.name === "ready") return ready(e, ctx);
  if (ctx.command?.name === "invite") return invite(e, ctx, ctx.command.handles);
  if (ctx.command) return void (await e.reply(ctx, copy.stillCollecting()));

  const reqs = await e.repo.getPredefined(ctx.member.id);
  const missing = missingFields(reqs);
  if (missing.length) return answer(e, ctx, reqs);
  if (/\b(change|actually|update|instead|correction|wait)\b/i.test(ctx.msg.text)) {
    const result = await extractWithGemini(e, ctx, reqs, null);
    if (result.changed.length) {
      await e.repo.savePredefined(ctx.member.id, ctx.trip.id, result.reqs);
      return void (await e.reply(ctx, copy.updated(recap(result.reqs))));
    }
  }
  await captureWish(e, ctx);
}

interface Extraction {
  reqs: PredefinedRequirements;
  changed: PredefinedField[];
  problems: string[];
}

/** One answer to the current question: deterministic first (instant), Gemini only if that can't read it. */
async function answer(e: Engine, ctx: Ctx, reqs: PredefinedRequirements): Promise<void> {
  const today = e.todayIn(ctx.trip.timeZone);
  const asked = missingFields(reqs)[0] ?? null;
  const quick = parseDeterministic(reqs, ctx.msg.text, today);
  const result = quick ? mergePredefined(reqs, quick, today) : await extractWithGemini(e, ctx, reqs, asked);
  // The route question says "round trip unless you say one way".
  if (result.reqs.startLocation && result.reqs.endLocation && result.reqs.tripType === null) {
    result.reqs.tripType = "round_trip";
    result.changed.push("tripType");
  }
  await e.repo.savePredefined(ctx.member.id, ctx.trip.id, result.reqs);

  const ack = acknowledge(result.reqs, result.changed);
  const parts = [ack ?? (result.problems.length ? null : copy.didntCatch()), ...result.problems];
  const next = nextQuestion(result.reqs);
  parts.push(next ?? copy.askWish());
  await e.reply(ctx, parts.filter(Boolean).join("\n"));
}

/** The group question being answered decides which reader runs. */
export function parseDeterministic(
  reqs: PredefinedRequirements,
  text: string,
  today: string,
): Partial<PredefinedRequirements> | null {
  const asked = missingFields(reqs)[0] ?? null;
  const step = STEPS.find((s) => asked && s.fields.includes(asked))?.step;
  switch (step) {
    case "route": {
      const route = parseRoute(text);
      if (route) return route.tripType ? route : { startLocation: route.startLocation, endLocation: route.endLocation };
      if (asked === "tripType") return parseFieldDeterministic("tripType", text);
      // Follow-up for the one missing end of the route: a short place name is the answer.
      const other = asked === "startLocation" ? reqs.endLocation : asked === "endLocation" ? reqs.startLocation : null;
      if (other && /^[\p{L}][\p{L} .,'-]{1,58}$/u.test(text.trim()) && text.trim().split(/\s+/).length <= 5) {
        return { [asked as "startLocation" | "endLocation"]: tidyPlace(text) };
      }
      return null;
    }
    case "dates": {
      const range = parseDateRange(text, today);
      if (range && asked === "endDate" && range.startDate === range.endDate) return { endDate: range.endDate };
      return range;
    }
    case "budgetDiet": {
      const found = parseBudgetDiet(text);
      if (!found) return null;
      // A lone diet answer to the budget question (or vice versa) still counts; the follow-up asks the rest.
      return Object.keys(found).length ? found : null;
    }
    default:
      return null;
  }
}

/** "👍 Chapel Hill → Wilmington (round trip)" — echoes what was understood, so typos are visible. */
function acknowledge(r: PredefinedRequirements, changed: PredefinedField[]): string | null {
  const bits: string[] = [];
  const has = (...fields: PredefinedField[]) => fields.some((f) => changed.includes(f));
  if (has("startLocation", "endLocation", "tripType") && r.startLocation && r.endLocation) {
    bits.push(`${r.startLocation} → ${r.endLocation}${r.tripType ? ` (${tripTypeLabel(r.tripType)})` : ""}`);
  } else if (has("startLocation", "endLocation")) bits.push(r.startLocation ?? r.endLocation ?? "");
  if (has("startDate", "endDate") && r.startDate && r.endDate) {
    bits.push(datesLabel({ startDate: r.startDate, endDate: r.endDate }));
  }
  if (has("budgetPerPersonUsd") && r.budgetPerPersonUsd !== null) bits.push(`$${r.budgetPerPersonUsd}/person`);
  if (has("dietaryRestrictions") && r.dietaryRestrictions) {
    bits.push(r.dietaryRestrictions.length ? r.dietaryRestrictions.join(", ") : "no dietary restrictions");
  }
  return bits.length ? `👍 ${bits.join(" · ")}` : null;
}

export function recap(r: PredefinedRequirements, wishes: string[] = []): string {
  const lines = [
    r.startLocation && r.endLocation
      ? `• 📍 ${r.startLocation} → ${r.endLocation}${r.tripType ? ` (${tripTypeLabel(r.tripType)})` : ""}`
      : "",
    r.startDate && r.endDate ? `• 📅 ${datesLabel({ startDate: r.startDate, endDate: r.endDate })}` : "",
    r.budgetPerPersonUsd !== null || r.dietaryRestrictions
      ? `• 💵 ${r.budgetPerPersonUsd !== null ? `$${r.budgetPerPersonUsd}` : "?"} · 🥗 ${r.dietaryRestrictions?.length ? r.dietaryRestrictions.join(", ") : "no restrictions"}`
      : "",
    wishes.length ? `• ✨ ${wishes.join("; ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Cheap deterministic answers for single fields (used by follow-ups); everything else goes to Gemini. */
export function parseFieldDeterministic(field: PredefinedField, text: string): Partial<PredefinedRequirements> | null {
  const t = text.trim();
  switch (field) {
    case "tripType":
      if (/\bround[\s-]?trip\b|\bthere and back\b|\breturn(ing)? home\b|^1\b/i.test(t))
        return { tripType: "round_trip" };
      if (/\bone[\s-]?way\b|^2\b/i.test(t)) return { tripType: "one_way" };
      return null;
    case "budgetPerPersonUsd": {
      const m = t.match(
        /^\$?\s*(\d{1,5}(?:\.\d{1,2})?)\s*(?:usd|dollars|bucks)?\s*(?:per person|pp|each|\/person)?\.?$/i,
      );
      const value = m ? Usd.safeParse(Number(m[1])) : null;
      return value?.success && value.data > 0 ? { budgetPerPersonUsd: value.data } : null;
    }
    case "dietaryRestrictions":
      return /^(none|no|nope|nothing|n\/a|no restrictions?|nah|i eat everything)\.?!?$/i.test(t)
        ? { dietaryRestrictions: [] }
        : null;
    case "startDate":
    case "endDate":
      return LocalDate.safeParse(t).success ? { [field]: t } : null;
    default:
      return null;
  }
}

async function extractWithGemini(
  e: Engine,
  ctx: Ctx,
  current: PredefinedRequirements,
  asked: PredefinedField | null,
): Promise<Extraction> {
  const today = e.todayIn(ctx.trip.timeZone);
  let found: Partial<PredefinedRequirements> | null = asked ? parseFieldDeterministic(asked, ctx.msg.text) : null;
  if (!found) {
    await e.typing(e.recipient(ctx.member));
    try {
      const out = await e.llm.generate({
        task: "predefined_extraction",
        system: SYSTEM.predefinedExtraction,
        prompt: `Today is ${today} (${ctx.trip.timeZone}).\nThe agent just asked for: ${asked ? FIELD_LABELS[asked] : "corrections to earlier answers"}.\nAlready known: ${JSON.stringify(current)}\nTraveler's message: """${ctx.msg.text}"""`,
        schema: PredefinedExtraction,
      });
      found = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null)) as Partial<PredefinedRequirements>;
    } catch (error) {
      e.log("predefined_extraction_failed", { error: String(error) });
      // Without Gemini a location answer can still be taken verbatim.
      const place = Place.safeParse(ctx.msg.text);
      found = (asked === "startLocation" || asked === "endLocation") && place.success ? { [asked]: place.data } : {};
    }
  }
  return mergePredefined(current, found, today);
}

/** Validates each extracted field on its own, then cross-checks dates. Invalid values are dropped with a note. */
export function mergePredefined(
  current: PredefinedRequirements,
  found: Partial<PredefinedRequirements>,
  today: string,
): Extraction {
  const next: PredefinedRequirements = { ...current };
  const changed: PredefinedField[] = [];
  const problems: string[] = [];
  const set = <K extends PredefinedField>(key: K, value: PredefinedRequirements[K]) => {
    if (JSON.stringify(next[key]) !== JSON.stringify(value)) changed.push(key);
    next[key] = value;
  };

  if (found.startLocation) {
    const v = Place.safeParse(found.startLocation);
    if (v.success) set("startLocation", v.data);
  }
  if (found.endLocation) {
    const v = Place.safeParse(found.endLocation);
    if (v.success) set("endLocation", v.data);
  }
  for (const key of ["startDate", "endDate"] as const) {
    const raw = found[key];
    if (!raw) continue;
    const v = LocalDate.safeParse(raw);
    if (!v.success) continue;
    if (v.data < today) problems.push(copy.datePassed(v.data));
    else set(key, v.data);
  }
  if (next.startDate && next.endDate && next.endDate < next.startDate) {
    problems.push(copy.endBeforeStart());
    const i = changed.indexOf("endDate");
    if (i >= 0) changed.splice(i, 1);
    next.endDate = null;
  }
  if (found.tripType) set("tripType", found.tripType);
  if (found.budgetPerPersonUsd !== undefined && found.budgetPerPersonUsd !== null) {
    const v = Usd.safeParse(found.budgetPerPersonUsd);
    if (v.success && v.data > 0) set("budgetPerPersonUsd", Math.round(v.data * 100) / 100);
  }
  if (found.dietaryRestrictions) {
    const items = found.dietaryRestrictions
      .map((d) => d.trim().slice(0, 60))
      .filter((d) => d && !/^(none|no|n\/a)$/i.test(d))
      .slice(0, 10);
    set("dietaryRestrictions", items);
  }
  return { reqs: next, changed, problems };
}

/**
 * The answer to "✨ Anything else?". The first one also finishes the member's planning (no `ready` needed).
 * OpenAI Decisions sorts it (a wish, and which kind, or nothing) in one fast call; Gemini is the fallback.
 */
async function captureWish(e: Engine, ctx: Ctx): Promise<void> {
  const finishing = !ctx.member.requirementsReady;
  const text = ctx.msg.text.trim();
  let wishes: Array<{ category: OptionalCategory; text: string }> = [];
  if (!isNoWish(text)) wishes = await classifyWish(e, ctx, text);
  for (const wish of wishes) {
    const parsed = RequirementText.safeParse(wish.text);
    if (!parsed.success) continue;
    await e.repo.addOptional({
      id: newId("req"),
      tripId: ctx.trip.id,
      memberId: ctx.member.id,
      category: wish.category,
      text: parsed.data,
      sourceEventId: ctx.msg.messageId,
    });
  }
  if (finishing) return finish(e, ctx);
  await e.reply(ctx, wishes.length ? copy.wishAdded(wishes.map((w) => w.text)) : copy.wishNothing());
}

const NO_WISH = "no_wish";

async function classifyWish(
  e: Engine,
  ctx: Ctx,
  text: string,
): Promise<Array<{ category: OptionalCategory; text: string }>> {
  const decided = await e.decider.choose({
    name: "wish_category",
    instructions:
      "A traveler was asked 'Anything else you'd love on this road trip?'. What kind of wish is their reply? Choose no_wish if it adds nothing (a no, a question, small talk).",
    evidence: `Reply: ${text}`,
    choices: [
      ...OptionalCategory.options.map((c) => ({ value: c, description: `A wish about ${c}` })),
      { value: NO_WISH, description: "Not a wish: no, nothing else, a question or small talk" },
    ],
  });
  if (decided) {
    if (decided.value === NO_WISH)
      return decided.confidence >= 0.6 ? [] : [{ category: "other", text: text.slice(0, 200) }];
    const category = OptionalCategory.safeParse(decided.value);
    return [{ category: category.success ? category.data : "other", text: text.slice(0, 200) }];
  }
  await e.typing(e.recipient(ctx.member));
  try {
    const out = await e.llm.generate({
      task: "optional_extraction",
      system: SYSTEM.optionalExtraction,
      prompt: `Traveler's message: """${text}"""`,
      schema: OptionalExtraction,
    });
    return out.requirements;
  } catch (error) {
    e.log("optional_extraction_failed", { error: String(error) });
    return [{ category: "other", text: text.slice(0, 200) }];
  }
}

async function ready(e: Engine, ctx: Ctx): Promise<void> {
  const reqs = await e.repo.getPredefined(ctx.member.id);
  const missing = missingFields(reqs);
  if (missing.length) {
    await e.reply(ctx, `${copy.stillMissing(missing)}\n${nextQuestion(reqs) ?? ""}`.trim());
    return;
  }
  if (ctx.member.requirementsReady) return void (await e.reply(ctx, copy.wishNothing()));
  await finish(e, ctx);
}

/** Marks the member done, shows their recap, and starts the vote once everyone is. */
async function finish(e: Engine, ctx: Ctx): Promise<void> {
  await e.repo.updateMember(ctx.member.id, { requirementsReady: true });
  const reqs = await e.repo.getPredefined(ctx.member.id);
  const wishes = (await e.repo.listOptional(ctx.trip.id))
    .filter((w) => w.memberId === ctx.member.id)
    .map((w) => w.text);
  const waiting = await waitingOn(e, ctx.trip.id);
  await e.reply(ctx, copy.allSet(recap(reqs, wishes), waiting));
  if (waiting.length === 0) await maybeBeginVoting(e, ctx.trip.id);
}

/** Who the vote is waiting for: unfinished members, pending invites, or more travelers. */
async function waitingOn(e: Engine, tripId: string): Promise<string[]> {
  const members = await e.repo.listMembers(tripId);
  const joined = members.filter((m) => m.status === "joined");
  const waiting = [
    ...joined.filter((m) => !m.requirementsReady).map((m) => e.displayName(m)),
    ...members.filter((m) => m.status === "invited").map((m) => copy.waitingOnInvite(m.handle)),
  ];
  if (joined.length < e.config.minMembers) waiting.push(copy.needMoreMembers());
  return waiting;
}

/** Voting starts when ≥ MIN_MEMBERS joined, no invite is pending, and every member has finished. */
export async function maybeBeginVoting(e: Engine, tripId: string): Promise<void> {
  if ((await waitingOn(e, tripId)).length) return;
  const members = await e.joinedMembers(tripId);
  const all = await Promise.all(members.map((m) => e.repo.getPredefined(m.id)));
  if (!all.every(isComplete)) return;
  await beginVoting(e, tripId);
}
