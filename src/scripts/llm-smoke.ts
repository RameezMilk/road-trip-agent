/** `npm run llm:smoke` — one structured + one grounded Gemini call, to check the key and model. */
import { loadConfig, requireConfig } from "../config";
import { ItineraryDraft, OptionalExtraction, ReplacementStop } from "../schemas";
import { GeminiLlm } from "../services/gemini";
import { SYSTEM } from "../services/prompts";

const config = requireConfig(loadConfig(), "Gemini", ["GEMINI_API_KEY"]);
const llm = new GeminiLlm(config.GEMINI_API_KEY, config.GEMINI_MODEL, (event, data) => console.log(event, data ?? ""));
console.log(`model: ${config.GEMINI_MODEL}`);
const extracted = await llm.generate({
  task: "optional_extraction",
  system: "Extract road-trip wishes as short requirements.",
  prompt: 'Traveler: "I want halal food and at least 5 rest stops, and maybe a waterfall"',
  schema: OptionalExtraction,
});
console.log("structured:", extracted);
const grounded = await llm.generate({
  task: "replacement_stop",
  system: "Find one real, currently open place with Google Search.",
  prompt: "A sushi restaurant in downtown Asheville, NC for lunch. Return the stop and a one-line summary.",
  schema: ReplacementStop,
  webSearch: true,
});
console.log("grounded:", grounded);
const draft = await llm.generate({
  task: "itinerary_draft",
  system: SYSTEM.itineraryDraft,
  prompt:
    "Plan this group road trip.\nStart: Chapel Hill, NC\nEnd: Asheville, NC\nTrip type: one way\nDates: 2026-10-17 to 2026-10-17 (1 day)\nBudget: $150 per person\nDietary restrictions: halal",
  schema: ItineraryDraft,
  webSearch: true,
});
console.log(
  "itinerary:",
  draft.days.map((d) => `day ${d.day} @${d.departTime}: ${d.stops.map((s) => `${s.kind}:${s.name}`).join(" → ")}`),
);
