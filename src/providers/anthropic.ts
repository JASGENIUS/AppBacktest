/**
 * AnthropicProvider — one forced tool call per decision, schema-constrained to
 * the closed action vocabulary. The client is created lazily on first decide()
 * so the module loads (and the provider constructs) without an API key.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentAction, AgentProvider, DecideContext, ProviderUsage } from "../core/types";
import { actionJsonSchema, parseAction, unwrapActionEnvelope } from "./actionSchema";
import { buildSystemPrompt, buildUserMessage } from "./prompt";

export interface AnthropicProviderConfig {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_EFFORT = "low";

export class AnthropicProvider implements AgentProvider {
  readonly name = "anthropic";
  /** Mutated in place as calls complete; the runner reads it once at the end. */
  readonly usage: ProviderUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  private client: Anthropic | null = null;

  constructor(private readonly cfg: AnthropicProviderConfig = {}) {}

  async decide(ctx: DecideContext): Promise<AgentAction> {
    const system = buildSystemPrompt(ctx);
    const userText = buildUserMessage(ctx);

    let response = await this.createMessage(system, userText);
    if (response.stop_reason === "refusal") {
      return { kind: "give_up", reason: "provider refused" };
    }
    try {
      return parseAction(this.extractToolInput(response));
    } catch (firstErr) {
      // One corrective retry: append the validation error to the user message.
      const corrective =
        `${userText}\n\nYour previous response was not a valid action ` +
        `(${(firstErr as Error).message}). Respond again with exactly one valid action.`;
      response = await this.createMessage(system, corrective);
      if (response.stop_reason === "refusal") {
        return { kind: "give_up", reason: "provider refused" };
      }
      try {
        return parseAction(this.extractToolInput(response));
      } catch (secondErr) {
        return {
          kind: "give_up",
          reason: `provider produced an invalid action twice: ${(secondErr as Error).message}`,
        };
      }
    }
  }

  private getClient(): Anthropic {
    if (this.client === null) {
      try {
        // SDK resolves ANTHROPIC_API_KEY (and profile config) from the environment.
        this.client = new Anthropic();
      } catch (err) {
        throw new Error(
          `ANTHROPIC_API_KEY missing or invalid — set it in .env or use provider.type: fixture (${(err as Error).message})`,
        );
      }
    }
    return this.client;
  }

  private buildParams(
    system: string,
    userText: string,
    includeThinking: boolean,
  ): Anthropic.MessageCreateParamsNonStreaming {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.cfg.model ?? DEFAULT_MODEL,
      max_tokens: 1024,
      output_config: { effort: this.cfg.effort ?? DEFAULT_EFFORT },
      system,
      messages: [{ role: "user", content: userText }],
      tools: [
        {
          name: "act",
          description: "Perform your next action as this user. Provide exactly one action object.",
          strict: true,
          input_schema: actionJsonSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: "act" },
    };
    if (includeThinking) params.thinking = { type: "disabled" };
    return params;
  }

  private async createMessage(system: string, userText: string): Promise<Anthropic.Message> {
    const client = this.getClient();
    try {
      return this.meter(await client.messages.create(this.buildParams(system, userText, true)));
    } catch (err) {
      if (this.isThinkingRejection(err)) {
        // Some models 400 on any thinking parameter — retry once without it.
        try {
          return this.meter(await client.messages.create(this.buildParams(system, userText, false)));
        } catch (retryErr) {
          throw this.wrapSdkError(retryErr);
        }
      }
      throw this.wrapSdkError(err);
    }
  }

  /** Every response that reaches us was billed, whether or not we could parse it. */
  private meter(response: Anthropic.Message): Anthropic.Message {
    this.usage.calls += 1;
    this.usage.inputTokens += response.usage?.input_tokens ?? 0;
    this.usage.outputTokens += response.usage?.output_tokens ?? 0;
    this.usage.cacheReadTokens =
      (this.usage.cacheReadTokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0);
    return response;
  }

  private isThinkingRejection(err: unknown): boolean {
    return (
      err instanceof Anthropic.APIError &&
      err.status === 400 &&
      String(err.message).toLowerCase().includes("thinking")
    );
  }

  private wrapSdkError(err: unknown): Error {
    if (err instanceof Anthropic.APIConnectionError) {
      return new Error(
        `Cannot reach the Anthropic API — check network/proxy settings: ${err.message}`,
      );
    }
    if (err instanceof Anthropic.APIError) {
      if (err.status === 401 || err.status === 403) {
        return new Error(
          "ANTHROPIC_API_KEY missing or invalid — set it in .env or use provider.type: fixture",
        );
      }
      if (err.status === 429) {
        return new Error(
          `Anthropic rate limit hit — wait and retry, lower runs, or use provider.type: fixture (${err.message})`,
        );
      }
      return new Error(`Anthropic API error${err.status ? ` (${err.status})` : ""}: ${err.message}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private extractToolInput(response: Anthropic.Message): unknown {
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error(
        `response contained no tool_use block (stop_reason: ${response.stop_reason})`,
      );
    }
    return unwrapActionEnvelope(toolUse.input);
  }
}
