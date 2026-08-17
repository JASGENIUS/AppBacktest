/**
 * FixtureProvider — deterministic, zero-key agent decisions from a JSON file.
 *
 * File format: {"decisions": [ ...AgentAction-shaped objects... ]} where any
 * "ref" field may instead be a target descriptor {"role"?, "nameContains"},
 * resolved at decide() time against the current perception. Decisions are
 * consumed strictly in order; exhaustion or an unresolvable target yields a
 * diagnosable give_up instead of a crash.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAction, AgentProvider, DecideContext, PerceivedElement } from "../core/types";
import { parseAction } from "./actionSchema";

interface RefTarget {
  role?: string;
  nameContains: string;
}

/** Collapse whitespace runs, trim, lowercase — matching is layout-agnostic. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function findElement(
  elements: readonly PerceivedElement[],
  target: RefTarget,
): PerceivedElement | undefined {
  const needle = normalize(target.nameContains);
  return elements.find(
    (el) =>
      (target.role === undefined || el.role === target.role) &&
      normalize(el.name).includes(needle),
  );
}

export class FixtureProvider implements AgentProvider {
  readonly name = "fixture";
  private decisions: unknown[] | null = null;
  private cursor = 0;

  constructor(private readonly fixturePath: string) {}

  async decide(ctx: DecideContext): Promise<AgentAction> {
    const decisions = this.load(ctx.actorName);
    if (this.cursor >= decisions.length) {
      return { kind: "give_up", reason: `fixture exhausted after ${decisions.length} decisions` };
    }
    const index = this.cursor;
    this.cursor += 1;
    return this.resolveDecision(decisions[index], index, ctx);
  }

  /**
   * Lazy read on first decide; relative paths resolve against process.cwd().
   *
   * Two shapes are accepted:
   *   {"decisions": [...]}                      — one probe
   *   {"actors": {"name": {"decisions": [...]}}} — one list per concurrent actor
   */
  private load(actorName?: string): unknown[] {
    if (this.decisions !== null) return this.decisions;
    const abs = path.isAbsolute(this.fixturePath)
      ? this.fixturePath
      : path.resolve(process.cwd(), this.fixturePath);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch (err) {
      throw new Error(
        `Fixture file not readable at ${abs} — check provider.path: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Fixture file ${abs} is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`Fixture file ${abs} must be an object`);
    }

    const actors = (parsed as { actors?: Record<string, { decisions?: unknown }> }).actors;
    if (actors && actorName) {
      const forActor = actors[actorName];
      if (!forActor || !Array.isArray(forActor.decisions)) {
        throw new Error(
          `Fixture file ${abs} has no decisions for actor "${actorName}" — defined actors: ${Object.keys(actors).join(", ") || "(none)"}`,
        );
      }
      this.decisions = forActor.decisions;
      return this.decisions;
    }

    if (!Array.isArray((parsed as { decisions?: unknown }).decisions)) {
      throw new Error(
        `Fixture file ${abs} must be {"decisions": [...]} or {"actors": {"<name>": {"decisions": [...]}}}`,
      );
    }
    this.decisions = (parsed as { decisions: unknown[] }).decisions;
    return this.decisions;
  }

  private resolveDecision(raw: unknown, index: number, ctx: DecideContext): AgentAction {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Fixture decision #${index} must be an object, got ${JSON.stringify(raw)}`);
    }
    const decision: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

    if (typeof decision.ref === "object" && decision.ref !== null) {
      const target = this.parseTarget(decision.ref, index);
      const match = findElement(ctx.perception.elements, target);
      if (!match) {
        return { kind: "give_up", reason: this.unresolvableReason(target, ctx) };
      }
      decision.ref = match.ref;
    }

    try {
      return parseAction(decision);
    } catch (err) {
      throw new Error(`Fixture decision #${index} invalid: ${(err as Error).message}`);
    }
  }

  private parseTarget(ref: object, index: number): RefTarget {
    const { role, nameContains } = ref as { role?: unknown; nameContains?: unknown };
    if (typeof nameContains !== "string" || nameContains.length === 0) {
      throw new Error(
        `Fixture decision #${index}: ref target must have a non-empty string "nameContains", got ${JSON.stringify(ref)}`,
      );
    }
    if (role !== undefined && typeof role !== "string") {
      throw new Error(
        `Fixture decision #${index}: ref target "role" must be a string when present, got ${JSON.stringify(role)}`,
      );
    }
    return { role, nameContains };
  }

  /** Diagnosability: name the missing target and list the first 10 perceived element names. */
  private unresolvableReason(target: RefTarget, ctx: DecideContext): string {
    const targetDesc =
      target.role !== undefined
        ? `role "${target.role}" with name containing "${target.nameContains}"`
        : `name containing "${target.nameContains}"`;
    const total = ctx.perception.elements.length;
    if (total === 0) {
      return `fixture target not found: ${targetDesc}; no elements perceived on ${ctx.perception.url}`;
    }
    const names = ctx.perception.elements
      .slice(0, 10)
      .map((el) => `'${el.name}'`)
      .join(", ");
    return `fixture target not found: ${targetDesc}; perceived elements (first ${Math.min(10, total)} of ${total}): ${names}`;
  }
}
