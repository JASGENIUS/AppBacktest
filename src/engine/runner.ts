/**
 * The run loop: perceive → decide → act → record, then judge.
 *
 * Layering rule: this module never imports Playwright or an LLM SDK — the
 * driver and provider arrive as interfaces, injected by the composition root.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Rng } from "../core/rng";
import { Redactor } from "../core/redaction";
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
  ProviderUsage,
  ResolvedActor,
  RngLike,
  RunEnding,
  RunPlan,
  RunRecord,
  StepRecord,
} from "../core/types";

export interface RunDeps {
  provider: AgentProvider;
  /**
   * Concurrent runs need one provider per actor (fixture providers carry
   * per-actor state). Falls back to `provider` when absent.
   */
  makeProvider?: () => AgentProvider;
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

/**
 * A single simulated person inside a concurrent run: their own browser
 * context (own session/cookies), own provider, own history and step budget.
 */
interface ActorState {
  name: string;
  actor: ResolvedActor;
  driver: BrowserDriver;
  provider: AgentProvider;
  history: HistoryEntry[];
  rng: RngLike;
  stepsTaken: number;
  finished: boolean;
  belief: AgentBelief | null;
  ending: RunEnding;
}

/**
 * Multi-user run: several people work the application at the same time.
 *
 * Turns are interleaved on a SEEDED schedule rather than by racing real
 * threads. That is deliberate — an interleaving that is reproducible is what
 * turns "sometimes two people clobber each other" into a fixture you can
 * replay. (True wall-clock parallelism would find a different, narrower class
 * of race and is not reproducible; it stays on the roadmap.)
 */
async function executeConcurrentRun(
  plan: RunPlan,
  deps: RunDeps,
  runDirAbs: string,
  finish: (
    partial: Pick<RunRecord, "steps" | "observations" | "evaluation">,
    usageFrom?: AgentProvider[],
  ) => RunRecord,
): Promise<RunRecord> {
  const { config } = deps;
  const actorPlans = plan.actors ?? [];
  const scheduleRng = new Rng(plan.subSeed).fork("schedule");

  const states: ActorState[] = actorPlans.map((actor, i) => ({
    name: actor.name,
    actor,
    driver: deps.makeDriver({
      appUrl: config.app.url,
      headless: config.browser.headless,
      device: actor.persona.device,
      actionTimeoutMs: config.browser.actionTimeoutMs,
      workDir: join(runDirAbs, `actor-${actor.name}`),
      uploadSizeKB: actor.persona.uploadSizeKB,
      uploadSeed: `${plan.subSeed}:${actor.name}:upload`,
      redactor: new Redactor(config.redaction),
      ...(config.browser.watch ? { watch: true, goal: `${actor.name}: ${actor.goal}` } : {}),
    }),
    provider: deps.makeProvider ? deps.makeProvider() : deps.provider,
    history: [],
    rng: new Rng(plan.subSeed).fork(`perturb:${actor.name}`),
    stepsTaken: 0,
    finished: false,
    belief: null,
    ending: "max_steps",
  }));

  const steps: StepRecord[] = [];
  let stepIndex = 0;
  let fatalError: string | undefined;

  try {
    for (const s of states) await s.driver.start();

    let prevEnd = Date.now();
    const totalBudget = states.reduce((n, s) => n + s.actor.persona.maxSteps, 0);

    while (steps.length < totalBudget) {
      const available = states.filter((s) => !s.finished && s.stepsTaken < s.actor.persona.maxSteps);
      if (available.length === 0) break;
      // Seeded choice of who moves next — this IS the interleaving.
      const state = scheduleRng.pick(available);

      const tsStart = new Date().toISOString();
      const elapsedMs = steps.length === 0 ? 0 : Date.now() - prevEnd;

      const perception = await state.driver.perceive();
      const digest = perceptionDigestOf(perception.url, perception.elements);
      const shotRel = `steps/${String(stepIndex).padStart(3, "0")}.png`;
      await state.driver.screenshot(join(runDirAbs, shotRel)).catch(() => {});

      let action: AgentAction;
      try {
        action = await state.provider.decide({
          goal: state.actor.goal,
          actorName: state.name,
          persona: state.actor.persona,
          appUrl: config.app.url,
          stepIndex: state.stepsTaken,
          maxSteps: state.actor.persona.maxSteps,
          history: state.history,
          perception,
        });
      } catch (err) {
        fatalError = `provider error (${state.name}): ${err instanceof Error ? err.message : String(err)}`;
        break;
      }

      const preTarget =
        "ref" in action && typeof action.ref === "string" ? state.driver.describeRef(action.ref) : undefined;
      const outcome = await state.driver.act(action, {
        persona: state.actor.persona,
        rng: state.rng.fork(`step:${state.stepsTaken}`),
      });

      // The click frame, cursor still on target — see StepRecord.screenshotAfter.
      const actShotRel = `steps/${String(stepIndex).padStart(3, "0")}-act.png`;
      const actShot = await state.driver
        .screenshot(join(runDirAbs, actShotRel))
        .then(() => actShotRel)
        .catch(() => undefined);

      const incidents = state.driver.drainIncidents();
      prevEnd = Date.now();

      const recordedAction: AgentAction =
        outcome.redactedText !== undefined && action.kind === "type"
          ? { ...action, text: outcome.redactedText }
          : action;

      steps.push({
        index: stepIndex,
        actor: state.name,
        elapsedMs,
        preUrl: perception.url,
        perceptionDigest: digest,
        perception: {
          title: perception.title,
          elementCount: perception.elements.length,
          ...(perception.modalOpen ? { modalOpen: perception.modalOpen } : {}),
        },
        action: recordedAction,
        ...(outcome.resolvedTarget ?? preTarget ? { target: outcome.resolvedTarget ?? preTarget } : {}),
        perturbations: outcome.perturbations,
        incidents,
        result: {
          ok: outcome.ok,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
          urlAfter: outcome.urlAfter,
        },
        screenshot: shotRel,
        ...(actShot ? { screenshotAfter: actShot } : {}),
        tsStart,
        tsEnd: new Date().toISOString(),
      });
      deps.events?.onStep?.(steps[steps.length - 1]!);

      state.history.push({
        index: state.stepsTaken,
        action: recordedAction,
        ok: outcome.ok,
        ...(outcome.error ? { error: outcome.error } : {}),
        urlAfter: outcome.urlAfter,
        feedback: feedbackOf(steps[steps.length - 1]!),
      });
      state.stepsTaken += 1;
      stepIndex += 1;

      if (action.kind === "done") {
        state.finished = true;
        state.ending = "done";
        state.belief = { outcome: action.outcome, summary: action.summary };
      } else if (action.kind === "give_up") {
        state.finished = true;
        state.ending = "gave_up";
        state.belief = { outcome: "failure", summary: action.reason };
      }
    }

    // The run's ending is the least happy of its participants.
    const ending: RunEnding = fatalError
      ? "fatal"
      : states.some((s) => s.ending === "gave_up")
        ? "gave_up"
        : states.every((s) => s.ending === "done")
          ? "done"
          : "max_steps";

    if (fatalError) {
      const observations = deriveObservations(steps, "fatal", config.observers);
      observations.unshift({ kind: "action_error", severity: "error", message: fatalError });
      return finish({
        steps,
        observations,
        evaluation: evaluate({
          checkResults: [],
          ending: "fatal",
          belief: null,
          observations,
          setupFailed: false,
          fatalError,
        }),
      });
    }

    // Checks run once, through the first actor's session, after everyone stops.
    const primary = states[0]!;
    await collectLateIncidents(primary.driver, steps);
    const transients = steps.flatMap((s) => s.incidents.transientMessages);
    let checkResults;
    try {
      checkResults = await runChecks(plan.checks, primary.driver, config.app.url, { transients });
    } catch (err) {
      checkResults = plan.checks.map((check) => ({
        check,
        passed: false,
        errored: true,
        detail: `evaluator failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }

    // Belief for a multi-user run: success only if everyone believed it worked.
    const beliefs = states.map((s) => s.belief).filter((b): b is AgentBelief => b !== null);
    const belief: AgentBelief | null =
      beliefs.length === 0
        ? null
        : {
            outcome: beliefs.every((b) => b.outcome === "success")
              ? "success"
              : beliefs.some((b) => b.outcome === "failure")
                ? "failure"
                : "unsure",
            summary: states
              .filter((s) => s.belief)
              .map((s) => `${s.name}: ${s.belief!.summary}`)
              .join(" | "),
          };

    const observations = deriveObservations(steps, ending, config.observers);
    return finish(
      {
        steps,
        observations,
        evaluation: evaluate({ checkResults, ending, belief, observations, setupFailed: false }),
      },
      states.map((s) => s.provider),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const observations = deriveObservations(steps, "fatal", config.observers);
    observations.unshift({ kind: "action_error", severity: "error", message });
    return finish(
      {
        steps,
        observations,
        evaluation: evaluate({
          checkResults: [],
          ending: "fatal",
          belief: null,
          observations,
          setupFailed: false,
          fatalError: message,
        }),
      },
      states.map((s) => s.provider),
    );
  } finally {
    for (const s of states) await s.driver.close().catch(() => {});
  }
}

/**
 * Total the token meters of every provider that billed during a run. Returns
 * undefined for providers that cost nothing (fixture, strict replay) so the
 * record simply carries no usage rather than a misleading row of zeroes.
 */
function sumUsage(providers: AgentProvider[]): ProviderUsage | undefined {
  const metered = providers.map((p) => p.usage).filter((u): u is ProviderUsage => u !== undefined);
  if (metered.length === 0) return undefined;
  const total: ProviderUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  for (const u of metered) {
    total.calls += u.calls;
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
  }
  return total.calls === 0 ? undefined : total;
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

  const finish = (
    partial: Pick<RunRecord, "steps" | "observations" | "evaluation">,
    // Multi-user runs meter one provider per actor; single-user runs, just the one.
    usageFrom: AgentProvider[] = [provider],
  ): RunRecord => {
    const usage = sumUsage(usageFrom);
    const record: RunRecord = {
      ...base,
      ...partial,
      ...(usage ? { provider: { ...base.provider, usage } } : {}),
      finishedAt: new Date().toISOString(),
    };
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

  // Multi-user scenarios take a different loop entirely.
  if (plan.actors && plan.actors.length > 0) {
    return executeConcurrentRun(plan, deps, runDirAbs, finish);
  }

  const driver = deps.makeDriver({
    appUrl: config.app.url,
    headless: config.browser.headless,
    device: plan.persona.device,
    actionTimeoutMs: config.browser.actionTimeoutMs,
    ...(config.browser.watch ? { watch: true, goal: plan.goal } : {}),
    redactor: new Redactor(config.redaction),
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

      // Capture the click itself, cursor still on the target. Taken before
      // draining incidents so the frame is as close to the action as possible.
      const actShotRel = `steps/${String(i).padStart(3, "0")}-act.png`;
      const actShot = await driver
        .screenshot(join(runDirAbs, actShotRel))
        .then(() => actShotRel)
        .catch(() => undefined);

      const incidents = driver.drainIncidents();
      prevEnd = Date.now();

      // A sensitive field's value never reaches the record — the trace keeps
      // the mask, so replay and reports carry no secret.
      const recordedAction: AgentAction =
        outcome.redactedText !== undefined && action.kind === "type"
          ? { ...action, text: outcome.redactedText }
          : action;

      const step: StepRecord = {
        index: i,
        elapsedMs,
        preUrl: perception.url,
        perceptionDigest: digest,
        perception: {
          title: perception.title,
          elementCount: perception.elements.length,
          ...(perception.modalOpen ? { modalOpen: perception.modalOpen } : {}),
        },
        action: recordedAction,
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
        ...(actShot ? { screenshotAfter: actShot } : {}),
        tsStart,
        tsEnd: new Date().toISOString(),
      };
      steps.push(step);
      deps.events?.onStep?.(step);

      history.push({
        index: i,
        action: recordedAction,
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
