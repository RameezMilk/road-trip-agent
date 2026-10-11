import { GoogleGenAI } from "@google/genai";
import { toLlmJsonSchema } from "../schemas";
import { type Llm, LlmError, type LlmRequest } from "./llm";

type Log = (event: string, data?: Record<string, unknown>) => void;

/**
 * Gemini via the Interactions API (the docs' recommended surface). Structured output plus Google Search
 * grounding in one call is a Gemini 3 feature; if the model rejects that combination we fall back to a
 * grounded text call followed by a structured call. Output is parsed with Zod; one repair retry.
 */
export class GeminiLlm implements Llm {
  private readonly client: GoogleGenAI;

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
    this.log("gemini_ok", { task: request.task, ms: Date.now() - started });
    return result.value;
  }

  private async structured<T>(request: LlmRequest<T>, prompt: string, webSearch: boolean): Promise<string> {
    const interaction = await this.client.interactions.create({
      model: this.model,
      system_instruction: request.system,
      input: prompt,
      store: false,
      ...(webSearch ? { tools: [{ type: "google_search" as const }] } : {}),
      response_format: { type: "text", mime_type: "application/json", schema: toLlmJsonSchema(request.schema) },
    });
    const text = (interaction as { output_text?: string }).output_text;
    if (!text) throw new LlmError(request.task, "empty response");
    return text;
  }

  private async grounded<T>(request: LlmRequest<T>): Promise<string> {
    const interaction = await this.client.interactions.create({
      model: this.model,
      system_instruction: `${request.system}\nResearch with Google Search and answer in concise plain-text notes.`,
      input: request.prompt,
      store: false,
      tools: [{ type: "google_search" as const }],
    });
    return (interaction as { output_text?: string }).output_text ?? "";
  }

  private parse<T>(request: LlmRequest<T>, text: string): { ok: true; value: T } | { ok: false; issues: string } {
    let json: unknown;
    try {
      json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
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
