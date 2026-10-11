import { GoogleGenAI } from "@google/genai";
import { toLlmJsonSchema } from "../schemas";
import { DEFAULT_EFFORT, type Llm, type LlmEffort, LlmError, type LlmImage, type LlmRequest } from "./llm";

type Log = (event: string, data?: Record<string, unknown>) => void;

/**
 * Gemini via the Interactions API (the docs' recommended surface). Structured output plus Google Search
 * grounding in one call is a Gemini 3 feature; if the model rejects that combination we fall back to a
 * grounded text call followed by a structured call. Output is parsed with Zod; one repair retry.
 * Each task runs at a thinking level (DEFAULT_EFFORT): default (high) thinking made drafts take ~85 s.
 */
export class GeminiLlm implements Llm {
  private readonly client: GoogleGenAI;
  /** Turned off for the process if the model rejects `thinking_level` outright. */
  private thinkingLevels = true;
  private readonly unsupported = new Set<LlmEffort>();

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly log: Log = () => {},
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate<T>(request: LlmRequest<T>): Promise<T> {
    const started = Date.now();
    let text: string;
    try {
      text = await this.structured(request, request.prompt, request.webSearch ?? false);
    } catch (error) {
      if (!request.webSearch) throw this.wrap(request, error);
      this.log("gemini_combined_failed", { task: request.task, error: String(error) });
      const notes = await this.grounded(request);
      text = await this.structured(request, `${request.prompt}\n\nWeb research notes:\n${notes}`, false);
    }

    let result = this.parse(request, text);
    if (!result.ok) {
      this.log("gemini_repair", { task: request.task, issues: result.issues });
      const repairPrompt = `${request.prompt}\n\nYour previous answer was invalid:\n${result.issues}\nPrevious answer:\n${text}\n\nReturn corrected JSON only.`;
      text = await this.structured(request, repairPrompt, false);
      result = this.parse(request, text);
      if (!result.ok) throw new LlmError(request.task, `invalid output after repair: ${result.issues}`);
    }
    this.log("gemini_ok", { task: request.task, ms: Date.now() - started, images: request.images?.length ?? 0 });
    return result.value;
  }

  private async structured<T>(request: LlmRequest<T>, prompt: string, webSearch: boolean): Promise<string> {
    const interaction = await this.create(request, {
      model: this.model,
      system_instruction: request.system,
      input: input(prompt, request.images),
      store: false,
      ...(webSearch ? { tools: [{ type: "google_search" as const }] } : {}),
      response_format: { type: "text", mime_type: "application/json", schema: toLlmJsonSchema(request.schema) },
    });
    const text = (interaction as { output_text?: string }).output_text;
    if (!text) throw new LlmError(request.task, "empty response");
    return text;
  }

  private async grounded<T>(request: LlmRequest<T>): Promise<string> {
    const interaction = await this.create(request, {
      model: this.model,
      system_instruction: `${request.system}\nResearch with Google Search and answer in concise plain-text notes.`,
      input: input(request.prompt, request.images),
      store: false,
      tools: [{ type: "google_search" as const }],
    });
    return (interaction as { output_text?: string }).output_text ?? "";
  }

  /**
   * Adds the task's thinking level. A level the model rejects ("THINKING_LEVEL_MINIMAL is not supported")
   * is remembered and the next one up is used; any other rejection retries once without a level.
   */
  private async create<T>(request: LlmRequest<T>, params: InteractionParams): Promise<unknown> {
    const wanted: LlmEffort = request.effort ?? DEFAULT_EFFORT[request.task];
    const effort = EFFORT_ORDER.slice(EFFORT_ORDER.indexOf(wanted)).find((e) => !this.unsupported.has(e));
    if (!this.thinkingLevels || !effort) return this.client.interactions.create(params);
    try {
      return await this.client.interactions.create({ ...params, generation_config: { thinking_level: effort } });
    } catch (error) {
      if (/thinking level/i.test(String(error))) {
        this.unsupported.add(effort);
        this.log("gemini_thinking_level_unsupported", { task: request.task, effort });
        return this.create(request, params);
      }
      const result = await this.client.interactions.create(params).catch(() => {
        throw error;
      });
      this.thinkingLevels = false;
      this.log("gemini_thinking_level_rejected", { task: request.task, effort, error: String(error) });
      return result;
    }
  }

  private parse<T>(request: LlmRequest<T>, text: string): { ok: true; value: T } | { ok: false; issues: string } {
    let json: unknown;
    try {
      json = decodeEntitiesDeep(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
    } catch {
      return { ok: false, issues: "not valid JSON" };
    }
    const parsed = request.schema.safeParse(json);
    if (parsed.success) return { ok: true, value: parsed.data };
    return {
      ok: false,
      issues: parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n"),
    };
  }

  private wrap<T>(request: LlmRequest<T>, error: unknown): Error {
    return error instanceof LlmError ? error : new LlmError(request.task, String(error));
  }
}

const EFFORT_ORDER: LlmEffort[] = ["minimal", "low", "medium", "high"];

/** The subset of `interactions.create` params we use (the SDK type is an overload union). */
interface InteractionParams {
  model: string;
  system_instruction: string;
  input: ReturnType<typeof input>;
  store: boolean;
  tools?: Array<{ type: "google_search" }>;
  response_format?: { type: "text"; mime_type: "application/json"; schema: Record<string, unknown> };
}

/** Plain text, or text followed by the member's images as inline parts. */
export function input(prompt: string, images: LlmImage[] | undefined) {
  if (!images?.length) return prompt;
  return [
    { type: "text" as const, text: prompt },
    ...images.map((i) => ({ type: "image" as const, data: i.base64, mime_type: i.mimeType })),
  ];
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/** Gemini sometimes HTML-escapes text inside JSON ("Waterfall &amp; Halal"); undo that in every string. */
export function decodeEntitiesDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);
  }
  if (Array.isArray(value)) return value.map(decodeEntitiesDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeEntitiesDeep(v)]));
  }
  return value;
}
