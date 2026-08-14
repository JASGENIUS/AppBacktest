/**
 * STRICT replay: re-execute a RunRecord's trace with no LLM and no PRNG.
 * Everything consumed comes from the record — recorded actions, recorded
 * perturbations, frozen checks. The seed is provenance only.
 *
 * Grading (see DESIGN.md):
 *   REPRODUCED    — trace replayed with matched identities; the originally-
 *                   failing checks fail again, cleanly.
 *   FIXED         — positive evidence only: every step's re-resolved target
 *                   matched the recorded descriptor, recorded perturbations
 *                   executed, and every frozen check now passes.
 *   DIVERGED      — a target could not be resolved or resolved to a different
 *                   element, or a recorded-ok step now hard-fails. Reported
 *                   with the first divergent step + reason. CI treats this as
 *                   gate-not-satisfied.
 *   INCONCLUSIVE  — the harness could not grade (reset missing/failed, check
 *                   transport errored, partial flip). Never counted as fixed.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveUrl } from "../core/config";
import { newRunId } from "../core/ids";
import { runChecks, evaluate } from "../evaluators";
import { deriveObservations } from "../observers";
import { writeRunRecord } from "./recorder";
import { collectLateIncidents, perceptionDigestOf } from "./runner";
import type {
  AppBacktestConfig,
  BrowserDriver,
  CheckResult,
  DriverOptions,
  EngineEvents,
  ReplayOutcome,
  RngLike,
  RunEnding,
  RunRecord,
  StepRecord,
} from "../core/types";

export interface ReplayDeps {
  makeDriver: (opts: DriverOptions) => BrowserDriver;
  config: AppBacktestConfig;
  outDirAbs: string;
  appbacktestVersion: string;
  events?: EngineEvents;
}

/** Strict replay must never draw randomness — this stub proves it. */
export const NEVER_RNG: RngLike = {
  labelPath: "strict-replay",
  next(): number {
    throw new Error("strict replay must not draw randomness");
  },
  int(): number {
    throw new Error("strict replay must not draw randomness");
  },
  pick<T>(): T {
    throw new Error("strict replay must not draw randomness");
  },
  chance(): boolean {
    throw new Error("strict replay must not draw randomness");
  },
  fork(): RngLike {
    return NEVER_RNG;
  },
};

const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
const nameMatch = (a: string, b: string) => {
  const na = norm(a);
  const nb = norm(b);
  return na === nb || (!!na && !!nb && (na.includes(nb) || nb.includes(na)));
};

const isElementAction = (kind: string) =>
  kind === "click" || kind === "type" || kind === "select" || kind === "upload";

function needsReset(record: RunRecord): boolean {
  return record.checks.some(
    (c) => c.type === "http" && (c.count !== undefined || c.equals !== undefined),
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function replayRun(record: RunRecord, deps: ReplayDeps): Promise<RunRecord> {
  const { config } = deps;
  const startedAt = new Date().toISOString();
  const replayId = newRunId(record.scenarioKey, record.subSeed);
  const runDirAbs = join(deps.outDirAbs, "runs", replayId);
  mkdirSync(join(runDirAbs, "steps"), { recursive: true });

  let outcome: ReplayOutcome | undefined;
  let divergence: { stepIndex: number; reason: string } | undefined;
  const steps: StepRecord[] = [];
  let checkResults: CheckResult[] = [];

  const diverge = (stepIndex: number, reason: string) => {
    outcome = "DIVERGED";
    divergence = { stepIndex, reason };
  };
  const inconclusive = (stepIndex: number, reason: string) => {
    outcome = "INCONCLUSIVE";
    divergence = { stepIndex, reason };
  };

  // --- Reset is part of grading integrity ---
  if (needsReset(record) && !config.app.resetHook) {
    inconclusive(-1, "app.resetHook is required to grade state checks (count/equals) — refusing to grade against dirty state");
  } else if (config.app.resetHook) {
    const hook = config.app.resetHook;
    const url = resolveUrl(config.app.url, hook.url);
    try {
      const res = await fetch(url, { method: hook.method, signal: AbortSignal.timeout(5000) });
      if (!res.ok) inconclusive(-1, `resetHook returned HTTP ${res.status} — cannot grade`);
    } catch (err) {
      inconclusive(-1, `resetHook failed: ${err instanceof Error ? err.message : String(err)} — cannot grade`);
    }
  }

  let driver: BrowserDriver | undefined;
  if (!outcome) {
    driver = deps.makeDriver({
      appUrl: config.app.url,
      headless: config.browser.headless,
      device: record.world.persona.device,
      actionTimeoutMs: config.browser.actionTimeoutMs,
      workDir: runDirAbs,
      uploadSizeKB: record.world.persona.uploadSizeKB,
      uploadSeed: `${record.subSeed}:upload`,
    });

    try {
      await driver.start();

      for (const recorded of record.steps) {
        if (recorded.action.kind === "done" || recorded.action.kind === "give_up") break;

        const tsStart = new Date().toISOString();
        let action = recorded.action;
        let readyRef: string | undefined;

        // Readiness gate: strict replay removes the settle time the LLM
        // round-trip used to provide — wait for the recorded pre-step state.
        const deadline = Date.now() + Math.max(recorded.elapsedMs, 1500);
        if (isElementAction(recorded.action.kind) && recorded.target) {
          while (Date.now() < deadline) {
            readyRef = await driver.resolveLocator(recorded.target);
            if (readyRef) break;
            await sleep(200);
          }
          if (!readyRef) {
            diverge(
              recorded.index,
              `target ${recorded.target.role} "${recorded.target.name}" not found within ${Math.max(recorded.elapsedMs, 1500)}ms`,
            );
            break;
          }
          action = { ...recorded.action, ref: readyRef } as typeof recorded.action;
        } else {
          const wantPath = safePathname(recorded.preUrl);
          const half = Date.now() + Math.max(recorded.elapsedMs, 1500) / 2;
          while (Date.now() < half) {
            if (safePathname(driver.currentUrl()) === wantPath) break;
            await sleep(200);
          }
        }

        const perception = await driver.perceive();
        const shotRel = `steps/${String(recorded.index).padStart(3, "0")}.png`;
        await driver.screenshot(join(runDirAbs, shotRel)).catch(() => {});

        const result = await driver.act(action, {
          persona: record.world.persona,
          rng: NEVER_RNG,
          forcedPerturbations: recorded.perturbations,
        });
        const incidents = driver.drainIncidents();

        steps.push({
          index: recorded.index,
          elapsedMs: recorded.elapsedMs,
          preUrl: perception.url,
          perceptionDigest: perceptionDigestOf(perception.url, perception.elements),
          perception: { title: perception.title, elementCount: perception.elements.length },
          action,
          ...(result.resolvedTarget ? { target: result.resolvedTarget } : {}),
          perturbations: recorded.perturbations,
          incidents,
          result: {
            ok: result.ok,
            ...(result.error ? { error: result.error } : {}),
            ...(result.errorKind ? { errorKind: result.errorKind } : {}),
            urlAfter: result.urlAfter,
          },
          screenshot: shotRel,
          tsStart,
          tsEnd: new Date().toISOString(),
        });

        // Positive-evidence rules
        if (isElementAction(recorded.action.kind) && recorded.target) {
          const got = result.resolvedTarget;
          if (!got || got.role !== recorded.target.role || !nameMatch(got.name, recorded.target.name)) {
            diverge(
              recorded.index,
              `resolved a different element: expected ${recorded.target.role} "${recorded.target.name}", got ${got ? `${got.role} "${got.name}"` : "none"}`,
            );
            break;
          }
        }
        if (recorded.result.ok && !result.ok) {
          diverge(
            recorded.index,
            `step failed on replay (${result.errorKind ?? "error"}: ${result.error ?? "?"}) but succeeded when recorded`,
          );
          break;
        }
      }

      // --- Grade against the FROZEN checks ---
      if (!outcome && driver) {
        // Machine-paced replay has no LLM think-time before grading — harvest
        // feedback that lands after the last click (same rule as live runs).
        await collectLateIncidents(driver, steps);
        const transients = steps.flatMap((s) => s.incidents.transientMessages);
        checkResults = await runChecks(record.checks, driver, config.app.url, { transients });
        const errored = checkResults.filter((r) => r.errored);
        if (errored.length > 0) {
          inconclusive(-1, `check could not evaluate: ${errored[0]!.detail ?? "transport error"}`);
        } else {
          const allPass = checkResults.every((r) => r.passed);
          const originallyFailing = new Set(
            record.evaluation.checkResults
              .filter((r) => !r.passed && !r.errored)
              .map((r) => JSON.stringify(r.check)),
          );
          if (allPass) {
            outcome = "FIXED";
          } else {
            const stillFailing = checkResults
              .filter((r) => !r.passed)
              .map((r) => JSON.stringify(r.check));
            const originalStillFail =
              originallyFailing.size > 0 &&
              [...originallyFailing].every((c) => stillFailing.includes(c));
            if (originalStillFail) {
              outcome = "REPRODUCED";
            } else {
              inconclusive(
                -1,
                "partial flip: the originally-failing checks now pass but other frozen checks fail — re-record this fixture",
              );
            }
          }
        }
      }
    } catch (err) {
      inconclusive(-1, `replay harness error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await driver?.close().catch(() => {});
    }
  }

  const ending: RunEnding = outcome === "DIVERGED" || outcome === "INCONCLUSIVE" ? "fatal" : "done";
  const observations = deriveObservations(steps, ending, config.observers);
  const replayRecord: RunRecord = {
    formatVersion: 1,
    appbacktestVersion: deps.appbacktestVersion,
    runId: replayId,
    seed: record.seed,
    subSeed: record.subSeed,
    scenarioKey: record.scenarioKey,
    personaKey: record.personaKey,
    goal: record.goal,
    world: record.world,
    provider: { type: "strict-replay" },
    app: { name: config.app.name, url: config.app.url },
    configHash: record.configHash,
    checks: record.checks,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
    observations,
    evaluation: evaluate({
      checkResults,
      ending,
      belief: null,
      observations,
      setupFailed: false,
      ...(divergence ? { fatalError: divergence.reason } : {}),
    }),
    replayOf: record.runId,
    replayOutcome: outcome ?? "INCONCLUSIVE",
    ...(divergence ? { divergence } : {}),
  };
  writeRunRecord(replayRecord, runDirAbs);
  deps.events?.onRunEnd?.(replayRecord);
  return replayRecord;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
