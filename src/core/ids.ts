import { sha256 } from "./hash";

/** Scenario segment is truncated to this many chars to keep paths short. */
const SCENARIO_SEGMENT_MAX = 40;

/**
 * Filesystem-safe run id: `<scenario>-<subseedHash8>-<yyyymmddHHMMSS>`.
 * Scenario key is sanitized to [A-Za-z0-9_-] and truncated to 40 chars;
 * the 8-char sub-seed hash preserves identity even when keys collide
 * after sanitization.
 */
export function newRunId(scenarioKey: string, subSeed: string): string {
  const scenario =
    scenarioKey.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, SCENARIO_SEGMENT_MAX) || "scenario";
  const hash8 = sha256(subSeed).slice(0, 8);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${scenario}-${hash8}-${ts}`;
}
