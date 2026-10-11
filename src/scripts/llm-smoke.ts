/** `npm run llm:smoke` — one structured + one grounded Gemini call, to check the key and model. */
import { loadConfig, requireConfig } from "../config";
import { OptionalExtraction, ReplacementStop } from "../schemas";
import { GeminiLlm } from "../services/gemini";

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
