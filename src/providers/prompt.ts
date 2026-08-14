/**
 * Shared decision-context building. Every LLM provider renders the SAME
 * persona/goal/history/perception context — providers differ only in
 * transport and output constraining, never in what the agent gets to see.
 */
import type { AgentAction, DecideContext, HistoryEntry, PerceivedElement } from "../core/types";

// Compact-context truncation bounds (history is one-liners by contract).
const TYPED_TEXT_MAX = 60;
const ERROR_MAX = 160;
const FEEDBACK_ITEM_MAX = 120;
const VALUE_MAX = 80;
const OPTIONS_MAX = 300;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function describeAction(action: AgentAction): string {
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

export function historyLine(entry: HistoryEntry): string {
  const status = entry.ok ? "ok" : `error: ${truncate(entry.error ?? "unknown", ERROR_MAX)}`;
  let line = `#${entry.index} ${describeAction(entry.action)} -> ${status}, url=${entry.urlAfter}`;
  if (entry.feedback && entry.feedback.length > 0) {
    line += `, saw: ${entry.feedback.map((f) => truncate(f, FEEDBACK_ITEM_MAX)).join("; ")}`;
  }
  return line;
}

export function elementLine(el: PerceivedElement): string {
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

export function buildSystemPrompt(ctx: DecideContext): string {
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

export function buildUserMessage(ctx: DecideContext): string {
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

/**
 * The closed vocabulary, spelled out for providers without schema-forced tool
 * calls (openai-compatible endpoints). parseAction remains the hard gate —
 * this text is guidance, the zod schema is law.
 */
export const ACTION_VOCABULARY = `Respond with exactly ONE JSON object and nothing else — no prose, no markdown fences, no reasoning. Valid actions:
{"kind":"navigate","url":"/path"}            go to a URL (same origin only)
{"kind":"click","ref":"f0:e1"}
{"kind":"type","ref":"f0:e1","text":"...","pressEnter":false}
{"kind":"select","ref":"f0:e1","value":"..."}
{"kind":"upload","ref":"f0:e1"}              choose a file via that element
{"kind":"press","key":"Escape"}              keys: Escape, Enter, Tab, ArrowDown, ArrowUp
{"kind":"scroll","direction":"down"}         or "up"
{"kind":"back"}
{"kind":"wait","ms":500}                     max 2000
{"kind":"done","outcome":"success","summary":"..."}   outcome: "success" or "unsure"
{"kind":"give_up","reason":"..."}`;
