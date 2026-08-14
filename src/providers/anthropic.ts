/**
 * AnthropicProvider — one forced tool call per decision, schema-constrained to
 * the closed action vocabulary. The client is created lazily on first decide()
 * so the module loads (and the provider constructs) without an API key.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentAction,
  AgentProvider,
  DecideContext,
  HistoryEntry,
  PerceivedElement,
} from "../core/types";
import { actionJsonSchema, parseAction, unwrapActionEnvelope } from "./actionSchema";

export interface AnthropicProviderConfig {
  model?: string;
  effort?: "low" | "medium" | "high";
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_EFFORT = "low";
// Compact-context truncation bounds (history is one-liners by contract).
const TYPED_TEXT_MAX = 60;
const ERROR_MAX = 160;
const FEEDBACK_ITEM_MAX = 120;
const VALUE_MAX = 80;
const OPTIONS_MAX = 300;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function describeAction(action: AgentAction): string {
  switch (action.kind) {
    case "navigate":
      return `navigate ${action.url}`;
    case "click":
      return `click ${action.ref}`;
    case "type":
      return `type ${action.ref} "${truncate(action.text, TYPED_TEXT_MAX)}"${action.pressEnter ? " +Enter" : ""}`;
    case "select":
      return `select ${action.ref} = ${action.value}`;
    case "upload":
      return `upload ${action.ref}`;
    case "press":
      return `press ${action.key}`;
    case "scroll":
      return `scroll ${action.direction}`;
    case "back":
      return "back";
    case "wait":
      return `wait ${action.ms}ms`;
    case "done":
      return `done (${action.outcome})`;
    case "give_up":
      return "give_up";
  }
}

function historyLine(entry: HistoryEntry): string {
  const status = entry.ok ? "ok" : `error: ${truncate(entry.error ?? "unknown", ERROR_MAX)}`;
  let line = `#${entry.index} ${describeAction(entry.action)} -> ${status}, url=${entry.urlAfter}`;
  if (entry.feedback && entry.feedback.length > 0) {
    line += `, saw: ${entry.feedback.map((f) => truncate(f, FEEDBACK_ITEM_MAX)).join("; ")}`;
  }
  return line;
}

function elementLine(el: PerceivedElement): string {
  const annotations: string[] = [];
  if (el.value !== undefined) annotations.push(`value="${truncate(el.value, VALUE_MAX)}"`);
  if (el.disabled) annotations.push("disabled");
  if (el.occluded) annotations.push("occluded");
  if (el.options && el.options.length > 0) {
    const opts = el.options
      .map((o) => (o.value === o.label ? o.value : `${o.value} (${o.label})`))
      .join(", ");
    annotations.push(`options: ${truncate(opts, OPTIONS_MAX)}`);
  }
  const suffix = annotations.length > 0 ? ` | ${annotations.join(" | ")}` : "";
  return `${el.ref} | ${el.role} | ${el.name}${suffix}`;
}

function buildSystemPrompt(ctx: DecideContext): string {
  const traits = ctx.persona.traits.length > 0 ? ctx.persona.traits.join(", ") : "none";
  const actionsLeft = ctx.maxSteps - ctx.stepIndex;
  return (
    `You are simulating a real person using a web application. ` +
    `Persona: ${ctx.persona.device}, patience ${ctx.persona.patience}, traits: ${traits}. ` +
    `Your goal: ${ctx.goal}. ` +
    `You are NOT testing the site; behave like a normal user trying to get this done. ` +
    `One action per turn. Interact only with elements listed in the perception, by their ref. ` +
    `When you believe the goal is complete use done (outcome success, or unsure if you could not confirm); ` +
    `if the goal seems impossible, give_up. You have ${actionsLeft} actions left.`
  );
}

function buildUserMessage(ctx: DecideContext): string {
  const lines: string[] = [];
  for (const entry of ctx.history) lines.push(historyLine(entry));
  if (ctx.history.length > 0) lines.push("");
  lines.push("CURRENT PAGE:");
  lines.push(`url: ${ctx.perception.url}`);
  lines.push(`title: ${ctx.perception.title}`);
  if (ctx.perception.modalOpen !== undefined) {
    lines.push(`modal open: ${ctx.perception.modalOpen}`);
  }
  lines.push(ctx.perception.textDigest);
  lines.push("ELEMENTS:");
  for (const el of ctx.perception.elements) lines.push(elementLine(el));
  return lines.join("\n");
}

export class AnthropicProvider implements AgentProvider {
  readonly name = "anthropic";
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
      return await client.messages.create(this.buildParams(system, userText, true));
    } catch (err) {
      if (this.isThinkingRejection(err)) {
        // Some models 400 on any thinking parameter — retry once without it.
        try {
          return await client.messages.create(this.buildParams(system, userText, false));
        } catch (retryErr) {
          throw this.wrapSdkError(retryErr);
        }
      }
      throw this.wrapSdkError(err);
    }
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
