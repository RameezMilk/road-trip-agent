import { datesLabel, isComplete, missingFields, tripTypeLabel } from "../../domain/reconcile";
import {
  LocalDate,
  newId,
  OptionalExtraction,
  Place,
  PredefinedExtraction,
  type PredefinedField,
  type PredefinedRequirements,
  RequirementText,
  Usd,
} from "../../schemas";
import { SYSTEM } from "../../services/prompts";
import { copy, FIELD_LABELS } from "../copy";
import type { Ctx, Engine } from "../engine";
import { begin as beginVoting } from "./voting";

export async function startPlanning(e: Engine, tripId: string): Promise<void> {
  for (const m of await e.joinedMembers(tripId)) {
    const reqs = await e.repo.getPredefined(m.id);
    const [next] = missingFields(reqs);
    await e.sendTo(e.recipient(m), `${copy.planningIntro()}\n\n${next ? copy.question(next) : ""}`.trim());
  }
}

export async function handle(e: Engine, ctx: Ctx): Promise<void> {
  if (ctx.command?.name === "ready") return ready(e, ctx);
  if (ctx.command) return void (await e.reply(ctx, "We're still collecting everyone's requirements."));

  const reqs = await e.repo.getPredefined(ctx.member.id);
  const missing = missingFields(reqs);
  const correcting = missing.length === 0 && /\b(change|actually|update|instead|correction|wait)\b/i.test(ctx.msg.text);
  if (missing.length || correcting) {
    const result = await extractPredefined(e, ctx, reqs, missing[0] ?? null);
    if (result.changed.length || missing.length) {
      await e.repo.savePredefined(ctx.member.id, ctx.trip.id, result.reqs);
      await e.reply(ctx, nextPrompt(result, missing.length > 0));
      return;
    }
  }
  await captureOptional(e, ctx);
}

interface Extraction {
  reqs: PredefinedRequirements;
  changed: PredefinedField[];
  problems: string[];
}

function nextPrompt(result: Extraction, wasMissing: boolean): string {
  const remaining = missingFields(result.reqs);
  const parts: string[] = [];
  if (!wasMissing) return copy.updated(recap(result.reqs));
  if (result.changed.length) parts.push(copy.captured(result.changed));
  parts.push(...result.problems);
  const [next] = remaining;
  if (next) {
    if (!result.changed.includes(next) && !result.changed.length && !result.problems.length)
      parts.push(copy.didntCatch(next));
    parts.push(copy.question(next));
    return parts.join("\n");
  }
  return copy.predefinedDone(recap(result.reqs));
}

export function recap(r: PredefinedRequirements): string {
  const lines = [
    `• From ${r.startLocation ?? "?"} to ${r.endLocation ?? "?"}${r.tripType ? ` (${tripTypeLabel(r.tripType)})` : ""}`,
    r.startDate && r.endDate ? `• ${datesLabel({ startDate: r.startDate, endDate: r.endDate })}` : "",
    r.budgetPerPersonUsd !== null ? `• $${r.budgetPerPersonUsd}/person` : "",
    r.dietaryRestrictions
      ? `• Dietary: ${r.dietaryRestrictions.length ? r.dietaryRestrictions.join(", ") : "none"}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Cheap deterministic answers for the field just asked; everything else goes to Gemini. */
export function parseFieldDeterministic(field: PredefinedField, text: string): Partial<PredefinedRequirements> | null {
  const t = text.trim();
  switch (field) {
    case "tripType":
      if (/\bround[\s-]?trip\b|\bthere and back\b|\breturn(ing)? home\b/i.test(t)) return { tripType: "round_trip" };
      if (/\bone[\s-]?way\b/i.test(t)) return { tripType: "one_way" };
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

async function extractPredefined(
  e: Engine,
  ctx: Ctx,
  current: PredefinedRequirements,
  asked: PredefinedField | null,
): Promise<Extraction> {
  const today = e.todayIn(ctx.trip.timeZone);
  let found: Partial<PredefinedRequirements> | null = asked ? parseFieldDeterministic(asked, ctx.msg.text) : null;
  if (!found) {
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
    if (v.data < today) problems.push(`${v.data} has already passed — pick a future date.`);
    else set(key, v.data);
  }
  if (next.startDate && next.endDate && next.endDate < next.startDate) {
    problems.push("The end date is before the start date.");
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

async function captureOptional(e: Engine, ctx: Ctx): Promise<void> {
  let items: Array<{ category: OptionalExtraction["requirements"][number]["category"]; text: string }> = [];
  try {
    const out = await e.llm.generate({
      task: "optional_extraction",
      system: SYSTEM.optionalExtraction,
      prompt: `Traveler's message: """${ctx.msg.text}"""`,
      schema: OptionalExtraction,
    });
    items = out.requirements;
  } catch (error) {
    e.log("optional_extraction_failed", { error: String(error) });
    const text = RequirementText.safeParse(ctx.msg.text.slice(0, 200));
    if (text.success) items = [{ category: "other", text: text.data }];
  }
  const saved: string[] = [];
  for (const item of items) {
    const text = RequirementText.safeParse(item.text);
    if (!text.success) continue;
    await e.repo.addOptional({
      id: newId("req"),
      tripId: ctx.trip.id,
      memberId: ctx.member.id,
      category: item.category,
      text: text.data,
      sourceEventId: ctx.msg.messageId,
    });
    saved.push(text.data);
  }
  await e.reply(ctx, saved.length ? copy.optionalNoted(saved) : copy.optionalNothing());
}

async function ready(e: Engine, ctx: Ctx): Promise<void> {
  const reqs = await e.repo.getPredefined(ctx.member.id);
  const missing = missingFields(reqs);
  const [next] = missing;
  if (next) {
    await e.reply(ctx, `${copy.stillMissing(missing)}\n${copy.question(next)}`);
    return;
  }
  await e.repo.updateMember(ctx.member.id, { requirementsReady: true });
  const members = await e.joinedMembers(ctx.trip.id);
  const readyCount = members.filter((m) => m.requirementsReady).length;
  await e.reply(ctx, copy.youreReady(readyCount, members.length));
  if (readyCount < members.length) {
    await e.broadcast(
      ctx.trip.id,
      copy.someoneReady(e.displayName(ctx.member), readyCount, members.length),
      ctx.member.id,
    );
    return;
  }
  const all = await Promise.all(members.map((m) => e.repo.getPredefined(m.id)));
  if (!all.every(isComplete)) return;
  await beginVoting(e, ctx.trip.id);
}
