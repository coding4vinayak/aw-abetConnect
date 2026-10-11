import { HeuristicEngine } from "./heuristic";
import { LlmEngine } from "./llm";
import type { IntelligenceEngine } from "./engine";

export type { IntelligenceEngine, TriageContext, DraftResult } from "./engine";
export { bucketForScore, BUCKET_THRESHOLDS, clampScore } from "./engine";
export { HeuristicEngine } from "./heuristic";
export { LlmEngine } from "./llm";

let cached: IntelligenceEngine | undefined;

/**
 * Pick the engine for this deployment.
 *
 * No key configured is a supported, first-class mode — not a degraded one. The
 * product ships working out of the box and gets better if you add a key.
 */
export function getEngine(): IntelligenceEngine {
  if (cached) return cached;

  const apiKey = process.env.LLM_API_KEY?.trim();
  if (apiKey) {
    cached = new LlmEngine({
      apiKey,
      baseUrl: process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1",
      model: process.env.LLM_MODEL?.trim() || "gpt-4o-mini",
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 12_000,
    });
  } else {
    cached = new HeuristicEngine();
  }
  return cached;
}

/** Test/seed hook: force a specific engine. */
export function setEngine(engine: IntelligenceEngine | undefined): void {
  cached = engine;
}
