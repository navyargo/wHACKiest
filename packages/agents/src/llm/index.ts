import { AnthropicProvider } from "./anthropic";
import { DeterministicMockProvider } from "./mock";
import type { LlmProvider } from "./provider";

let cached: LlmProvider | null = null;

/** Anthropic when ANTHROPIC_API_KEY is set; otherwise the offline rule-based provider. */
export function getProvider(): LlmProvider {
  if (cached) return cached;
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  cached = key ? new AnthropicProvider(key) : new DeterministicMockProvider();
  return cached;
}

export function aiModeLabel(p: LlmProvider = getProvider()) {
  return p.mode === "LIVE" ? `AI: ${p.name.replace("anthropic:", "Anthropic ")} (LIVE)` : "Offline AI mode — rule-based";
}

export { AnthropicProvider, DeterministicMockProvider };
export type { LlmProvider };
