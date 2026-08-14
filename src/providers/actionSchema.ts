/**
 * The closed action vocabulary, enforced at the provider boundary.
 *
 * Two artifacts that MUST stay in lockstep:
 *   - `parseAction` (zod) — validates anything a provider produces.
 *   - `actionJsonSchema` (hand-written plain JSON Schema) — sent to the LLM as
 *     a strict tool schema. Keys/enums/bounds mirror the zod schema exactly;
 *     the providers test walks every variant to keep them aligned.
 */
import { z } from "zod";
import type { AgentAction } from "../core/types";

const PRESSABLE_KEYS = ["Escape", "Enter", "Tab", "ArrowDown", "ArrowUp"] as const;
const SCROLL_DIRECTIONS = ["up", "down"] as const;
const DONE_OUTCOMES = ["success", "unsure"] as const;

// strictObject ⇒ unknown keys are errors (additionalProperties: false).
const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("navigate"), url: z.string() }),
  z.strictObject({ kind: z.literal("click"), ref: z.string() }),
  z.strictObject({
    kind: z.literal("type"),
    ref: z.string(),
    text: z.string(),
    pressEnter: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("select"), ref: z.string(), value: z.string() }),
  z.strictObject({ kind: z.literal("upload"), ref: z.string() }),
  z.strictObject({ kind: z.literal("press"), key: z.enum(PRESSABLE_KEYS) }),
  z.strictObject({ kind: z.literal("scroll"), direction: z.enum(SCROLL_DIRECTIONS) }),
  z.strictObject({ kind: z.literal("back") }),
  // wait is capped at 2000ms — the executor never sleeps longer than 2s per action.
  z.strictObject({ kind: z.literal("wait"), ms: z.number().int().min(1).max(2000) }),
  z.strictObject({
    kind: z.literal("done"),
    outcome: z.enum(DONE_OUTCOMES),
    summary: z.string(),
  }),
  z.strictObject({ kind: z.literal("give_up"), reason: z.string() }),
]);

/** Validates an unknown value as an AgentAction. Throws with a readable message. */
export function parseAction(input: unknown): AgentAction {
  const result = actionSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid agent action: ${issues}`);
  }
  return result.data;
}

/**
 * Plain JSON Schema for the "act" tool (strict mode). Hand-written — no
 * zod-to-json-schema dependency. Must match `parseAction` exactly.
 */
export const actionJsonSchema: Record<string, unknown> = {
  anyOf: [
    {
      type: "object",
      properties: { kind: { const: "navigate" }, url: { type: "string" } },
      required: ["kind", "url"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "click" }, ref: { type: "string" } },
      required: ["kind", "ref"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "type" },
        ref: { type: "string" },
        text: { type: "string" },
        pressEnter: { type: "boolean" },
      },
      required: ["kind", "ref", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "select" },
        ref: { type: "string" },
        value: { type: "string" },
      },
      required: ["kind", "ref", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "upload" }, ref: { type: "string" } },
      required: ["kind", "ref"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "press" }, key: { enum: [...PRESSABLE_KEYS] } },
      required: ["kind", "key"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "scroll" }, direction: { enum: [...SCROLL_DIRECTIONS] } },
      required: ["kind", "direction"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "back" } },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "wait" },
        ms: { type: "integer", minimum: 1, maximum: 2000 },
      },
      required: ["kind", "ms"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "done" },
        outcome: { enum: [...DONE_OUTCOMES] },
        summary: { type: "string" },
      },
      required: ["kind", "outcome", "summary"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "give_up" }, reason: { type: "string" } },
      required: ["kind", "reason"],
      additionalProperties: false,
    },
  ],
};
