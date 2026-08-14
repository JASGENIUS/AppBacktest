/**
 * OpenAiCompatibleProvider — any /v1/chat/completions endpoint (NVIDIA NIM,
 * OpenAI, Ollama, vLLM, ...). No SDK dependency: plain fetch.
 *
 * Output constraining differs from the Anthropic provider: these endpoints
 * have wildly uneven tool-calling support, so the action vocabulary is
 * prompted and the response is parsed with a hardened extractor (reasoning
 * tags stripped, fenced blocks unwrapped, balanced-brace scan). parseAction
 * (zod) remains the structural gate either way — an invalid action cannot
 * leave this module; it triggers one corrective retry, then give_up.
 */
import type { AgentAction, AgentProvider, DecideContext } from "../core/types";
import { parseAction } from "./actionSchema";
import { ACTION_VOCABULARY, buildSystemPrompt, buildUserMessage } from "./prompt";

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  model: string;
  /** Env var holding the bearer token. Omit for keyless endpoints (Ollama). */
  apiKeyEnv?: string;
  temperature?: number;
  maxTokens?: number;
}

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Pull the first parseable JSON object out of model output. Exported for
 * tests. Handles: reasoning tags (<think>...</think>, including unclosed),
 * ```json fences, prose-wrapped objects, nested braces, strings with braces.
 */
export function extractJsonCandidate(raw: string): unknown {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  // Unclosed reasoning tag: everything before the answer is reasoning.
  const unclosed = text.lastIndexOf("<think>");
  if (unclosed !== -1 && !text.includes("</think>", unclosed)) {
    text = text.slice(0, unclosed);
  }

  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const fence of fences) {
    try {
      return JSON.parse(fence[1]!.trim());
    } catch {
      // fall through to the brace scan
    }
  }

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = inString;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString && ch === "{") {
        depth += 1;
      } else if (!inString && ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break; // this candidate is malformed; try the next "{"
          }
        }
      }
    }
  }
  throw new Error(`no JSON object found in model output: "${raw.slice(0, 120)}"`);
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}

export class OpenAiCompatibleProvider implements AgentProvider {
  readonly name = "openai_compatible";

  constructor(private readonly cfg: OpenAiCompatibleConfig) {}

  async decide(ctx: DecideContext): Promise<AgentAction> {
    const system = `${buildSystemPrompt(ctx)}\n\n${ACTION_VOCABULARY}`;
    const userText = buildUserMessage(ctx);

    const first = await this.complete(system, userText);
    try {
      return parseAction(extractJsonCandidate(first));
    } catch (firstErr) {
      const corrective =
        `${userText}\n\nYour previous response was not a valid action ` +
        `(${(firstErr as Error).message}). Respond again with ONLY one valid JSON action object.`;
      const second = await this.complete(system, corrective);
      try {
        return parseAction(extractJsonCandidate(second));
      } catch (secondErr) {
        return {
          kind: "give_up",
          reason: `provider produced an invalid action twice: ${(secondErr as Error).message}`,
        };
      }
    }
  }

  /** One chat completion; returns the raw content string ("" when absent). */
  private async complete(system: string, userText: string): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKeyEnv) {
      const key = process.env[this.cfg.apiKeyEnv];
      if (!key) {
        throw new Error(
          `${this.cfg.apiKeyEnv} not set — the openai_compatible provider needs it in the environment/.env`,
        );
      }
      headers.authorization = `Bearer ${key}`;
    }

    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: this.cfg.temperature ?? DEFAULT_TEMPERATURE,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userText },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `cannot reach ${url}${/abort|timeout/i.test(reason) ? ` within ${REQUEST_TIMEOUT_MS / 1000}s (model cold-start or overload?)` : ""}: ${reason}`,
      );
    }

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `${url} rejected the key (${res.status}) — check ${this.cfg.apiKeyEnv ?? "the endpoint's auth"}: ${body}`,
        );
      }
      if (res.status === 404 || res.status === 410) {
        throw new Error(
          `model "${this.cfg.model}" is not deployed at ${this.cfg.baseUrl} (${res.status}) — ` +
            `listed-but-not-deployed is common; probe GET ${this.cfg.baseUrl}/models and pick a live one: ${body}`,
        );
      }
      if (res.status === 429) {
        throw new Error(`rate limited by ${this.cfg.baseUrl} (429) — wait and retry, or lower runs: ${body}`);
      }
      throw new Error(`${url} returned ${res.status}: ${body}`);
    }

    const json = (await res.json().catch(() => ({}))) as ChatCompletionResponse;
    if (json.error?.message) throw new Error(`${this.cfg.model}: ${json.error.message}`);
    return json.choices?.[0]?.message?.content ?? "";
  }
}
