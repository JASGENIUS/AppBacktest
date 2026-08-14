import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executeRun } from "../src/engine/runner";
import { replayRun, NEVER_RNG } from "../src/engine/replayer";
import { toPosixRelative } from "../src/engine/recorder";
import type {
  ActOptions,
  ActOutcome,
  AgentAction,
  AgentProvider,
  AppBacktestConfig,
  BrowserDriver,
  DriverOptions,
  Perception,
  ResilientLocator,
  RunPlan,
  RunRecord,
  StepRecord,
} from "../src/core/types";
import { resolvePersona } from "../src/core/worldgen";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "abt-engine-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const persona = resolvePersona({ patience: "low" });

function makeConfig(overrides: Partial<AppBacktestConfig["app"]> = {}): AppBacktestConfig {
  return {
    app: { name: "Mock", url: "http://localhost:9", ...overrides },
    provider: { type: "fixture", path: "unused.json" },
    personas: {},
    scenarios: {},
    runs: 1,
    browser: { headless: true, actionTimeoutMs: 1000 },
    observers: { ignoreConsole: [], ignoreRequests: [] },
    outDir: ".backtests",
  };
}

function makePlan(checks: RunPlan["checks"]): RunPlan {
  return {
    runId: "mock-run-1",
    subSeed: "s:sc:0",
    scenarioKey: "sc",
    personaKey: "p",
    goal: "do the thing",
    persona,
    checks,
  };
}

interface MockDriverOpts {
  perception?: Partial<Perception>;
  visibleText?: string;
  resolveTo?: string | undefined;
  actResult?: Partial<ActOutcome>;
}

function makeMockDriver(opts: MockDriverOpts = {}): BrowserDriver & { clicked: AgentAction[] } {
  const perception: Perception = {
    url: "http://localhost:9/",
    title: "Mock",
    textDigest: opts.visibleText ?? "Upload received",
    elements: [{ ref: "e1", role: "button", name: "Upload POD", nth: 0 }],
    ...opts.perception,
  };
  const clicked: AgentAction[] = [];
  return {
    clicked,
    async start() {},
    async perceive() {
      return perception;
    },
    describeRef(ref: string): ResilientLocator | undefined {
      const el = perception.elements.find((e) => e.ref === ref);
      return el ? { role: el.role, name: el.name, nth: el.nth } : undefined;
    },
    async resolveLocator() {
      return "resolveTo" in opts ? opts.resolveTo : "e1";
    },
    async act(action: AgentAction, _o: ActOptions): Promise<ActOutcome> {
      clicked.push(action);
      return {
        ok: true,
        urlAfter: "http://localhost:9/done",
        perturbations: [],
        resolvedTarget: { role: "button", name: "Upload POD", nth: 0 },
        ...opts.actResult,
      };
    },
    async screenshot() {},
    drainIncidents() {
      return { consoleDelta: [], networkDelta: [], transientMessages: [], dialogs: [], tabSwitched: false };
    },
    async visibleText() {
      return opts.visibleText ?? "Upload received";
    },
    currentUrl() {
      return "http://localhost:9/done";
    },
    async contextGet() {
      return { status: 200, body: "[]" };
    },
    async close() {},
  };
}

function scriptedProvider(actions: AgentAction[]): AgentProvider {
  let i = 0;
  return {
    name: "test",
    async decide() {
      const a = actions[Math.min(i, actions.length - 1)];
      i += 1;
      return a!;
    },
  };
}

function runDeps(config: AppBacktestConfig, outDirAbs: string, driver: BrowserDriver, provider: AgentProvider) {
  return {
    provider,
    makeDriver: (_o: DriverOptions) => driver,
    config,
    outDirAbs,
    seed: "s",
    configHashValue: "hash",
    appbacktestVersion: "0.0.0-test",
    events: {},
  };
}

describe("executeRun", () => {
  it("happy path: PASS, frozen checks, belief, POSIX screenshot paths", async () => {
    const out = tempDir();
    const config = makeConfig();
    const driver = makeMockDriver();
    const provider = scriptedProvider([
      { kind: "click", ref: "e1" },
      { kind: "done", outcome: "success", summary: "clicked it" },
    ]);
    const record = await executeRun(makePlan([{ type: "text", contains: "Upload received" }]), runDeps(config, out, driver, provider));

    expect(record.evaluation.verdict).toBe("PASS");
    expect(record.evaluation.ending).toBe("done");
    expect(record.evaluation.agentBelief).toEqual({ outcome: "success", summary: "clicked it" });
    expect(record.checks).toEqual([{ type: "text", contains: "Upload received" }]);
    expect(record.steps).toHaveLength(2);
    for (const s of record.steps) {
      expect(s.screenshot).toMatch(/^steps\/\d{3}\.png$/); // POSIX relative
      expect(s.perceptionDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // record.json written and reads back
    const onDisk = JSON.parse(readFileSync(join(out, "runs", "mock-run-1", "record.json"), "utf8")) as RunRecord;
    expect(onDisk.runId).toBe("mock-run-1");
  });

  it("resetHook failure ⇒ SETUP_FAILED quarantine with zero steps", async () => {
    const out = tempDir();
    // port 9 (discard) refuses instantly — the hook cannot succeed
    const config = makeConfig({ resetHook: { method: "POST", url: "http://127.0.0.1:9/reset" } });
    const record = await executeRun(
      makePlan([]),
      runDeps(config, out, makeMockDriver(), scriptedProvider([{ kind: "back" }])),
    );
    expect(record.evaluation.verdict).toBe("SETUP_FAILED");
    expect(record.evaluation.failureKind).toBe("setup_failed");
    expect(record.steps).toHaveLength(0);
  });

  it("provider throw ⇒ FAIL technical with the error surfaced as an observation", async () => {
    const out = tempDir();
    const provider: AgentProvider = {
      name: "boom",
      async decide() {
        throw new Error("kaboom from provider");
      },
    };
    const record = await executeRun(makePlan([]), runDeps(makeConfig(), out, makeMockDriver(), provider));
    expect(record.evaluation.verdict).toBe("FAIL");
    expect(record.evaluation.failureKind).toBe("technical");
    expect(record.observations.some((o) => o.message.includes("kaboom"))).toBe(true);
  });
});

describe("replayRun", () => {
  function syntheticRecord(checks: RunRecord["checks"], failing: RunRecord["checks"]): RunRecord {
    const step: StepRecord = {
      index: 0,
      elapsedMs: 10,
      preUrl: "http://localhost:9/",
      perceptionDigest: "x",
      perception: { title: "Mock", elementCount: 1 },
      action: { kind: "click", ref: "e1" },
      target: { role: "button", name: "Upload POD", nth: 0 },
      perturbations: [{ kind: "double_click" }],
      incidents: { consoleDelta: [], networkDelta: [], transientMessages: [], dialogs: [], tabSwitched: false },
      result: { ok: true, urlAfter: "http://localhost:9/done" },
      tsStart: "t",
      tsEnd: "t",
    };
    return {
      formatVersion: 1,
      appbacktestVersion: "0.0.0-test",
      runId: "orig-1",
      seed: "s",
      subSeed: "s:sc:0",
      scenarioKey: "sc",
      personaKey: "p",
      goal: "g",
      world: { persona },
      provider: { type: "fixture" },
      app: { name: "Mock", url: "http://localhost:9" },
      configHash: "hash",
      checks,
      startedAt: "t",
      finishedAt: "t",
      steps: [step, {
        ...step,
        index: 1,
        action: { kind: "done", outcome: "success", summary: "ok" },
        target: undefined,
        perturbations: [],
      }],
      observations: [],
      evaluation: {
        verdict: "FAIL",
        failureKind: "assertion",
        ending: "done",
        checkResults: checks.map((check) => ({
          check,
          passed: !failing.includes(check),
          errored: false,
        })),
        agentBelief: { outcome: "success", summary: "ok" },
        discrepancy: true,
        reverseDiscrepancy: false,
        passedWithObservations: false,
      },
    };
  }

  function replayDeps(driver: BrowserDriver, out: string) {
    return {
      makeDriver: (_o: DriverOptions) => driver,
      config: makeConfig(),
      outDirAbs: out,
      appbacktestVersion: "0.0.0-test",
    };
  }

  const textCheck = { type: "text", contains: "Upload received" } as const;

  it("FIXED requires matched identity + all frozen checks passing", async () => {
    const driver = makeMockDriver({ visibleText: "Upload received" });
    const record = syntheticRecord([textCheck], [textCheck]);
    const replayed = await replayRun(record, replayDeps(driver, tempDir()));
    expect(replayed.replayOutcome).toBe("FIXED");
    expect(replayed.replayOf).toBe("orig-1");
    // the recorded perturbation was forced through, not re-rolled
    const clickCall = driver.clicked.find((a) => a.kind === "click");
    expect(clickCall).toBeTruthy();
  });

  it("REPRODUCED when the originally-failing check fails again cleanly", async () => {
    const driver = makeMockDriver({ visibleText: "nothing here" });
    const record = syntheticRecord([textCheck], [textCheck]);
    const replayed = await replayRun(record, replayDeps(driver, tempDir()));
    expect(replayed.replayOutcome).toBe("REPRODUCED");
  }, 20_000);

  it("DIVERGED when the recorded target no longer resolves", async () => {
    const driver = makeMockDriver({ resolveTo: undefined });
    const record = syntheticRecord([textCheck], [textCheck]);
    const replayed = await replayRun(record, replayDeps(driver, tempDir()));
    expect(replayed.replayOutcome).toBe("DIVERGED");
    expect(replayed.divergence?.stepIndex).toBe(0);
    expect(replayed.divergence?.reason).toContain("not found");
  });

  it("DIVERGED when the target resolves to a different element", async () => {
    const driver = makeMockDriver({
      actResult: { resolvedTarget: { role: "button", name: "Delete everything", nth: 0 } },
    });
    const record = syntheticRecord([textCheck], [textCheck]);
    const replayed = await replayRun(record, replayDeps(driver, tempDir()));
    expect(replayed.replayOutcome).toBe("DIVERGED");
    expect(replayed.divergence?.reason).toContain("different element");
  });

  it("NEVER_RNG refuses every draw (strict replay must not touch randomness)", () => {
    expect(() => NEVER_RNG.next()).toThrow(/must not draw randomness/);
    expect(() => NEVER_RNG.chance(0.5)).toThrow(/must not draw randomness/);
    expect(NEVER_RNG.fork("x")).toBe(NEVER_RNG);
  });
});

describe("toPosixRelative", () => {
  it("emits forward slashes regardless of platform separators", () => {
    const base = join("E:", "proj", "out");
    const abs = join(base, "runs", "r1", "steps", "001.png");
    expect(toPosixRelative(abs, base)).toBe("runs/r1/steps/001.png");
  });
});
