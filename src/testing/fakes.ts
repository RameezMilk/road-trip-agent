import { createHash } from "node:crypto";
import type { z } from "zod";
import type { CardLayout, ChatPort, Recipient } from "../chat/port";
import { estimateLeg } from "../domain/geo";
import type { CardRef, LatLng, RouteLeg } from "../schemas";
import type { ChooseQuestion, Decider, PredicateQuestion } from "../services/decisions";
import type { GeocodeResult, Geocoder, Router } from "../services/geo";
import { type Llm, LlmError, type LlmRequest, type LlmTask } from "../services/llm";

// Test doubles. Nothing here is used by the running agent.

type Handler = (request: LlmRequest<unknown>) => unknown;

/** Scripted LLM: each task has a queue of canned answers (or a function). Output still goes through the schema. */
export class FakeLlm implements Llm {
  readonly calls: Array<{ task: LlmTask; prompt: string; images: number }> = [];
  private readonly scripts = new Map<LlmTask, Array<unknown | Handler>>();

  on(task: LlmTask, ...answers: Array<unknown | Handler>): this {
    this.scripts.set(task, [...(this.scripts.get(task) ?? []), ...answers]);
    return this;
  }

  /** Replaces whatever is still scripted for `task`. */
  set(task: LlmTask, ...answers: Array<unknown | Handler>): this {
    this.scripts.set(task, answers);
    return this;
  }

  async generate<T>(request: LlmRequest<T>): Promise<T> {
    this.calls.push({ task: request.task, prompt: request.prompt, images: request.images?.length ?? 0 });
    const queue = this.scripts.get(request.task) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new LlmError(request.task, "no scripted answer");
    const raw = typeof next === "function" ? (next as Handler)(request as LlmRequest<unknown>) : next;
    return (request.schema as z.ZodType<T>).parse(raw);
  }
}

type ChooseAnswer = { value: string; confidence: number } | null;

/**
 * Scripted Decider keyed by question name. Unscripted questions return null (= unavailable), which sends
 * callers down their Gemini fallback, exactly like running without OPENAI_API_KEY.
 */
export class FakeDecider implements Decider {
  readonly asked: string[] = [];
  private readonly choices = new Map<string, (q: ChooseQuestion) => ChooseAnswer>();
  private readonly predicates = new Map<string, number | null>();

  onChoose(name: string, answer: ChooseAnswer | ((q: ChooseQuestion) => ChooseAnswer)): this {
    this.choices.set(name, typeof answer === "function" ? answer : () => answer);
    return this;
  }

  onPredicate(name: string, probability: number | null): this {
    this.predicates.set(name, probability);
    return this;
  }

  async choose(q: ChooseQuestion): Promise<ChooseAnswer> {
    this.asked.push(q.name);
    return this.choices.get(q.name)?.(q) ?? null;
  }

  async predicate(q: PredicateQuestion): Promise<number | null> {
    this.asked.push(q.name);
    return this.predicates.get(q.name) ?? null;
  }
}

/** Deterministic coordinates around central NC for any query; `unknown` queries can be configured to fail. */
export class FakeGeocoder implements Geocoder {
  readonly queries: string[] = [];
  constructor(private readonly failing: RegExp[] = []) {}

  async geocode(query: string): Promise<GeocodeResult | null> {
    this.queries.push(query);
    if (this.failing.some((r) => r.test(query))) return null;
    const h = createHash("sha256").update(query.toLowerCase()).digest();
    const latLng: LatLng = { lat: 35 + (h[0] ?? 0) / 255, lng: -82 + (h[1] ?? 0) / 100 };
    return { latLng, displayName: `${query} (fake)` };
  }
}

export class FakeRouter implements Router {
  async route(points: Array<{ id: string; latLng: LatLng }>): Promise<RouteLeg[]> {
    return points.slice(1).map((p, i) => estimateLeg(points[i] as (typeof points)[number], p));
  }
}

export interface SentMessage {
  to: string;
  text: string | null;
  card: { url: string; layout: CardLayout; edited: boolean } | null;
  attachment?: { path: string; mimeType: string };
}

export class FakeChat implements ChatPort {
  readonly sent: SentMessage[] = [];
  private cardCounter = 0;
  readonly blocked = new Set<string>();

  async sendText(to: Recipient, text: string): Promise<void> {
    if (this.blocked.has(to.handle)) throw new Error("Target not allowed for this project");
    this.sent.push({ to: to.handle, text, card: null });
  }

  async sendCard(to: Recipient, url: string, layout: CardLayout): Promise<CardRef | null> {
    this.sent.push({ to: to.handle, text: null, card: { url, layout, edited: false } });
    return { messageId: `card-${++this.cardCounter}`, session: { n: this.cardCounter } };
  }

  async editCard(to: Recipient, card: CardRef, url: string, layout: CardLayout): Promise<CardRef | null> {
    this.sent.push({ to: to.handle, text: null, card: { url, layout, edited: true } });
    return card;
  }

  readonly typingTo: string[] = [];

  async sendAttachment(to: Recipient, path: string, mimeType: string): Promise<void> {
    this.sent.push({ to: to.handle, text: null, card: null, attachment: { path, mimeType } });
  }

  async typing(to: Recipient): Promise<void> {
    this.typingTo.push(to.handle);
  }

  /** Everything sent to a handle, as short labels: the text, "[card]", "[card edit]" or "[file name]". */
  timeline(handle: string): string[] {
    return this.sent
      .filter((m) => m.to === handle)
      .map((m) =>
        m.text !== null
          ? m.text
          : m.card
            ? m.card.edited
              ? "[card edit]"
              : "[card]"
            : `[file ${m.attachment?.path.split("/").at(-1)}]`,
      );
  }

  /** Texts sent to a handle since the last `take`. */
  textsTo(handle: string): string[] {
    return this.sent.filter((m) => m.to === handle && m.text).map((m) => m.text as string);
  }

  lastTextTo(handle: string): string {
    return this.textsTo(handle).at(-1) ?? "";
  }

  clear(): void {
    this.sent.length = 0;
  }
}
