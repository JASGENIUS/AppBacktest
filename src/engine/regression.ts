/**
 * Regression runner: strict-replay every promoted fixture in
 * .backtests/regressions/. REPRODUCED and DIVERGED both fail the gate —
 * a UI refactor must not be able to quietly diverge fixtures to green.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRunRecord } from "./recorder";
import { replayRun } from "./replayer";
import type { ReplayDeps } from "./replayer";
import type { ReplayOutcome } from "../core/types";

export interface RegressionResult {
  fixtureId: string;
  outcome: ReplayOutcome;
  divergence?: { stepIndex: number; reason: string };
}

export async function runRegression(deps: ReplayDeps): Promise<RegressionResult[]> {
  const regDir = join(deps.outDirAbs, "regressions");
  if (!existsSync(regDir)) return [];

  const fixtureIds = readdirSync(regDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const results: RegressionResult[] = [];
  for (const fixtureId of fixtureIds) {
    try {
      const record = readRunRecord(join(regDir, fixtureId));
      const replayed = await replayRun(record, deps);
      results.push({
        fixtureId,
        outcome: replayed.replayOutcome ?? "INCONCLUSIVE",
        ...(replayed.divergence ? { divergence: replayed.divergence } : {}),
      });
    } catch (err) {
      results.push({
        fixtureId,
        outcome: "INCONCLUSIVE",
        divergence: { stepIndex: -1, reason: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return results;
}
