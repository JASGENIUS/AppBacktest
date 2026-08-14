import type { AgentProvider, ProviderConfig } from "../core/types";
import { AnthropicProvider } from "./anthropic";
import { FixtureProvider } from "./fixture";

/**
 * Composition factory for agent providers. Both providers defer any external
 * resource (fixture file, API client) until the first decide() call.
 */
export function createProvider(cfg: ProviderConfig): AgentProvider {
  switch (cfg.type) {
    case "anthropic":
      return new AnthropicProvider({ model: cfg.model, effort: cfg.effort });
    case "fixture":
      return new FixtureProvider(cfg.path);
  }
}
