import { createHash } from "node:crypto";
import type { AppBacktestConfig } from "./types";

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Deterministic JSON serialization: object keys sorted recursively, array
 * order preserved, undefined values skipped in objects (as JSON.stringify
 * does). Same value ⇒ same string, regardless of key insertion order.
 */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") {
    // Covers string/number/boolean; NaN/Infinity serialize as "null" like JSON.
    return JSON.stringify(v) ?? "null";
  }
  if (Array.isArray(v)) {
    return `[${v.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    if (value === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Stable hash of the full (validated, defaulted) config. */
export function configHash(config: AppBacktestConfig): string {
  return sha256(stableStringify(config));
}
