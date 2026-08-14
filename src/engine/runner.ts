/**
 * The run loop: perceive → decide → act → record, then judge.
 *
 * Layering rule: this module never imports Playwright or an LLM SDK — the
 * driver and provider arrive as interfaces, injected by the composition root.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Rng } from "../core/rng";
import { sha256, stableStringify } from "../core/hash";
import { resolveUrl } from "../core/config";
import { runChecks, evaluate } from "../evaluators";
import { deriveObservations } from "../observers";
import { writeRunRecord } from "./recorder";
import type {
  AgentBelief,
  AgentAction,
  AppBacktestConfig,
  AgentProvider,
  BrowserDriver,
  DriverOptions,
  EngineEvents,
  HistoryEntry,
  RunEnding,
  RunPlan,
  RunRecord,
  StepRecord,
} from "../core/types";

export interface RunDeps {
  provider: AgentProvider;
  makeDriver: (opts: DriverOptions) => BrowserDriver;
  config: AppBacktestConfig;
  outDirAbs: string;
  seed: string;
  configHashValue: string;
  appbacktestVersion: string;
  events?: EngineEvents;
}

const RESET_TIMEOUT_MS = 5000;

export function perceptionDigestOf(url: string, elements: Array<{ role: string; name: string; nth: number }>): string {
  return sha256(stableStringify({ url, els: elements.map((e) => [e.role, e.name, e.nth]) }));
}

/**
 * Harvest incidents that arrive after the final action (a toast landing when
 * the last request resolves). perceive() is what pulls in-page transients, so
 * settle, perceive once, drain, and fold into the last step's incidents.
 */
export async function collectLateIncidents(driver: BrowserDriver, steps: StepRecord[]): Promise<void> {
  if (steps.length === 0) return;
  await new Promise((r) => setTimeout(r, 800));
  try {
    await driver.perceive();
  } catch {
    return; // page gone — nothing late to collect
  }
  const late = driver.drainIncidents();
  const last = steps[steps.length - 1]!.incidents;
  last.consoleDelta.push(...late.consoleDelta);
  last.networkDelta.push(...late.networkDelta);
  last.transientMessages.push(...late.transientMessages);
  last.dialogs.push(...late.dialogs);
  if (late.tabSwitched) last.tabSwitched = true;
}

async function invokeResetHook(config: AppBacktestConfig): Promise<string | null> {
  const hook = config.app.resetHook;
  if (!hook) return null;
  const url = resolveUrl(config.app.url, hook.url);
  try {
    const res = await fetch(url, { method: hook.method, signal: AbortSignal.timeout(RESET_TIMEOUT_MS) });
    if (!res.ok) return `resetHook ${hook.method} ${url} returned HTTP ${res.status}`;
    return null;
  } catch (err) {
    return `resetHook ${hook.method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Feedback a user would have seen after an action (toasts + dialog text), capped. */
function feedbackOf(step: StepRecord): string[] {
  const out = [
    ...step.incidents.transientMessages.slice(0, 3),
    ...step.incidents.dialogs.slice(0, 2).map((d) => `[${d.dialogType}] ${d.message}`),
  ];
  return out.slice(0, 4);
}

export async function executeRun(plan: RunPlan, deps: RunDeps): Promise<RunRecord> {
  const { config, provider } = deps;
  const startedAt = new Date().toISOString();
  const runDirAbs = join(deps.outDirAbs, "runs", plan.runId);
  mkdirSync(join(runDirAbs, "steps"), { recursive: true });
  deps.events?.onRunStart?.(plan);

  const base: Omit<RunRecord, "steps" | "observations" | "evaluation" | "finishedAt"> = {
    formatVersion: 1,
    appbacktestVersion: deps.appbacktestVersion,
    runId: plan.runId,
    seed: deps.seed,
    subSeed: plan.subSeed,
    scenarioKey: plan.scenarioKey,
    personaKey: plan.personaKey,
    goal: plan.goal,
    world: { persona: plan.persona },
    provider: {
      type: config.provider.type,
      ...("model" in config.provider && config.provider.model
        ? { model: config.provider.model }
        : {}),
    },
    app: { name: config.app.name, url: config.app.url },
    configHash: deps.configHashValue,
    checks: plan.checks,
    startedAt,
  };

  const finish = (partial: Pick<RunRecord, "steps" | "observations" | "evaluation">): RunRecord => {
    const record: RunRecord = { ...base, ...partial, finishedAt: new Date().toISOString() };
    writeRunRecord(record, runDirAbs);
    deps.events?.onRunEnd?.(record);
    return record;
  };

  // --- Reset (part of the determinism contract for stateful apps) ---
  const resetError = await invokeResetHook(config);
  if (resetError) {
    return finish({
      steps: [],
      observations: [],
      evaluation: evaluate({
        checkResults: [],
        ending: "fatal",
        belief: null,
        observations: [],
        setupFailed: true,
        fatalError: resetError,
      }),
    });
  }

  const driver = deps.makeDriver({
    appUrl: config.app.url,
    headless: config.browser.headless,
    device: plan.persona.device,
    actionTimeoutMs: config.browser.actionTimeoutMs,
    workDir: runDirAbs,
    uploadSizeKB: plan.persona.uploadSizeKB,
    uploadSeed: `${plan.subSeed}:upload`,
  });

  const steps: StepRecord[] = [];
  const history: HistoryEntry[] = [];
  let ending: RunEnding = "max_steps";
  let belief: AgentBelief | null = null;
  let fatalError: string | undefined;

  try {
    await driver.start();

    let prevEnd = Date.now();
    for (let i = 0; i < plan.persona.maxSteps; i++) {
      const tsStart = new Date().toISOString();
      const elapsedMs = i === 0 ? 0 : Date.now() - prevEnd;

      const perception = await driver.perceive();
      const digest = perceptionDigestOf(perception.url, perception.elements);

      const shotRel = `steps/${String(i).padStart(3, "0")}.png`;
      await driver.screenshot(join(runDirAbs, shotRel)).catch(() => {});

      let action: AgentAction;
      try {
        action = await provider.decide({
          goal: plan.goal,
          persona: plan.persona,
          appUrl: config.app.url,
          stepIndex: i,
          maxSteps: plan.persona.maxSteps,
          history,
          perception,
        });
      } catch (err) {
        fatalError = `provider error: ${err instanceof Error ? err.message : String(err)}`;
        ending = "fatal";
        break;
      }

      const preTarget =
        "ref" in action && typeof action.ref === "string" ? driver.describeRef(action.ref) : undefined;
      const rng = new Rng(plan.subSeed).fork("perturb").fork(`step:${i}`);
      const outcome = await driver.act(action, { persona: plan.persona, rng });
      const incidents = driver.drainIncidents();
      prevEnd = Date.now();

      const step: StepRecord = {
        index: i,
        elapsedMs,
        preUrl: perception.url,
        perceptionDigest: digest,
        perception: { title: perception.title, elementCount: perception.elements.length },
        action,
        ...(outcome.resolvedTarget ?? preTarget
          ? { target: outcome.resolvedTarget ?? preTarget }
          : {}),
        perturbations: outcome.perturbations,
        incidents,
        result: {
          ok: outcome.ok,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
          urlAfter: outcome.urlAfter,
        },
        screenshot: shotRel,
        tsStart,
        tsEnd: new Date().toISOString(),
      };
      steps.push(step);
      deps.events?.onStep?.(step);

      history.push({
        index: i,
        action,
        ok: outcome.ok,
        ...(outcome.error ? { error: outcome.error } : {}),
        urlAfter: outcome.urlAfter,
        feedback: feedbackOf(step),
      });

      if (action.kind === "done") {
        ending = "done";
        belief = { outcome: action.outcome, summary: action.summary };
        break;
      }
      if (action.kind === "give_up") {
        ending = "gave_up";
        belief = { outcome: "failure", summary: action.reason };
        break;
      }
    }

    if (ending === "fatal") {
      const observations = deriveObservations(steps, ending, config.observers);
      if (fatalError) {
        // A fatal error must never be invisible in the record.
        observations.unshift({ kind: "action_error", severity: "error", message: fatalError });
      }
      return finish({
        steps,
        observations,
        evaluation: evaluate({
          checkResults: [],
          ending,
          belief,
          observations,
          setupFailed: false,
          fatalError,
        }),
      });
    }

    // --- Judgment (independent of the agent's belief) ---
    // Final feedback can land AFTER the last action's harvest (server latency
    // outliving the click) — settle briefly and fold late incidents into the
    // last step so the trace and the transient checks both see them.
    await collectLateIncidents(driver, steps);
    const transients = steps.flatMap((s) => s.incidents.transientMessages);
    let checkResults;
    try {
      checkResults = await runChecks(plan.checks, driver, config.app.url, { transients });
    } catch (err) {
      checkResults = plan.checks.map((check) => ({
        check,
        passed: false,
        errored: true,
        detail: `evaluator failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
    const observations = deriveObservations(steps, ending, config.observers);
    return finish({
      steps,
      observations,
      evaluation: evaluate({ checkResults, ending, belief, observations, setupFailed: false }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const observations = deriveObservations(steps, "fatal", config.observers);
    observations.unshift({ kind: "action_error", severity: "error", message });
    return finish({
      steps,
      observations,
      evaluation: evaluate({
        checkResults: [],
        ending: "fatal",
        belief,
        observations,
        setupFailed: false,
        fatalError: message,
      }),
    });
  } finally {
    await driver.close().catch(() => {});
  }
}
