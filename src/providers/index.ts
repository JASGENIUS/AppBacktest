import type { AgentProvider, ProviderConfig } from "../core/types";
import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatibleProvider } from "./openaiCompatible";
import { FixtureProvider } from "./fixture";

/**
 * Composition factory for agent providers. Every provider defers external
 * resources (fixture file, API client, network) until the first decide() call.
 */
export function createProvider(cfg: ProviderConfig): AgentProvider {
  switch (cfg.type) {
    case "anthropic":
      return new AnthropicProvider({ model: cfg.model, effort: cfg.effort });
    case "openai_compatible":
      return new OpenAiCompatibleProvider({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKeyEnv: cfg.apiKeyEnv,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      });
    case "fixture":
      return new FixtureProvider(cfg.path);
  }
}
