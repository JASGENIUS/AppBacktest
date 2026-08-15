/**
 * Capture-time redaction.
 *
 * The rule from the spec: prevent sensitive values from being recorded rather
 * than scrubbing them afterwards. So this is applied by the driver as evidence
 * is produced — the raw secret never reaches a RunRecord, a screenshot path, a
 * report, or the LLM's context.
 *
 * Two independent gates:
 *   - FIELD:  the element being typed into looks sensitive (password input, or
 *             an accessible name matching a field pattern) → the whole value is
 *             replaced before it is recorded.
 *   - VALUE:  any captured text or URL containing something that looks like a
 *             credential → that substring is replaced.
 */

import type { RedactionConfig } from "./types";

export class Redactor {
  /** Non-global: safe for repeated .test() (a /g/ regex is stateful). */
  private readonly fieldRe: RegExp[];
  /** Global: used with .replace() to catch every occurrence. */
  private readonly valueRe: RegExp[];

  constructor(private readonly cfg: RedactionConfig) {
    // Defensive at the boundary: a hand-built config missing these must not
    // crash a run — and must not silently disable redaction either.
    this.fieldRe = compile(cfg?.fieldPatterns ?? [], "i");
    this.valueRe = compile(cfg?.valuePatterns ?? [], "gi");
  }

  get enabled(): boolean {
    return this.cfg?.enabled ?? false;
  }

  get mask(): string {
    return this.cfg?.mask ?? "[redacted]";
  }

  /** Does this element's name/role mark it as holding a secret? */
  isSensitiveField(name: string, role?: string): boolean {
    if (!this.enabled) return false;
    if (role === "password") return true;
    return this.fieldRe.some((re) => re.test(name));
  }

  /** Mask a value typed into a sensitive field — length is not preserved. */
  maskField(): string {
    return this.mask;
  }

  /** Replace credential-shaped substrings anywhere in free text. */
  text(input: string): string {
    if (!this.enabled || !input) return input;
    let out = input;
    for (const re of this.valueRe) out = out.replace(re, this.mask);
    return out;
  }

  /**
   * Redact a URL: query/hash parameters whose NAME looks sensitive lose their
   * value, and credential-shaped substrings anywhere are masked. Malformed
   * URLs fall back to plain text redaction.
   */
  url(input: string): string {
    if (!this.enabled || !input) return input;
    try {
      const u = new URL(input);
      for (const key of [...u.searchParams.keys()]) {
        if (this.fieldRe.some((re) => re.test(key))) u.searchParams.set(key, this.mask);
      }
      return this.text(u.toString());
    } catch {
      return this.text(input);
    }
  }
}

function compile(patterns: string[], flags: string): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, flags));
    } catch {
      // A bad user pattern must never take down a run; skip it.
    }
  }
  return out;
}
