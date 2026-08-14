import { describe, expect, it } from "vitest";
import type {
  AgentAction,
  BrowserDriver,
  CheckConfig,
  CheckResult,
  IncidentDrain,
  Perception,
  StepRecord,
  StepResult,
  TextCheck,
} from "../src/core/types";
import { deriveObservations } from "../src/observers/index";
import { getPath } from "../src/evaluators/jsonpath";
import { evaluate, runChecks } from "../src/evaluators/index";

const FAST = { settleMs: 0, pollMs: 1 }; // keep polling paths fast in tests

// ---------------------------------------------------------------------------
// Mocks & builders
// ---------------------------------------------------------------------------

function makeDriver(overrides: Partial<BrowserDriver> = {}): BrowserDriver {
  const perception: Perception = {
    url: "http://app.local/",
    title: "App",
    textDigest: "",
    elements: [],
  };
  return {
    start: async () => {},
    perceive: async () => perception,
    describeRef: () => undefined,
    resolveLocator: async () => undefined,
    act: async () => ({ ok: true, urlAfter: "http://app.local/", perturbations: [] }),
    screenshot: async () => {},
    drainIncidents: () => emptyIncidents(),
    visibleText: async () => "",
    currentUrl: () => "http://app.local/",
    contextGet: async () => ({ status: 200, body: "{}" }),
    close: async () => {},
    ...overrides,
  };
}

function emptyIncidents(): IncidentDrain {
  return {
    consoleDelta: [],
    networkDelta: [],
    transientMessages: [],
    dialogs: [],
    tabSwitched: false,
  };
}

function makeStep(
  index: number,
  over: {
    incidents?: Partial<IncidentDrain>;
    result?: Partial<StepResult>;
    action?: AgentAction;
  } = {},
): StepRecord {
  return {
    index,
    elapsedMs: 0,
    preUrl: "http://app.local/",
    perceptionDigest: "digest",
    perception: { title: "App", elementCount: 0 },
    action: over.action ?? { kind: "wait", ms: 100 },
    perturbations: [],
    incidents: { ...emptyIncidents(), ...over.incidents },
    result: { ok: true, urlAfter: "http://app.local/", ...over.result },
    tsStart: "2026-01-01T00:00:00.000Z",
    tsEnd: "2026-01-01T00:00:01.000Z",
  };
}

const obsCfg = (over: Partial<{ ignoreConsole: string[]; ignoreRequests: string[] }> = {}) => ({
  ignoreConsole: [],
  ignoreRequests: [],
  ...over,
});

function passResult(): CheckResult {
  return { check: { type: "url", contains: "/" }, passed: true, errored: false };
}
function failResult(): CheckResult {
  return { check: { type: "url", contains: "/x" }, passed: false, errored: false };
}
function erroredResult(): CheckResult {
  return {
    check: { type: "http", url: "/api", count: 1 },
    passed: false,
    errored: true,
    detail: "HTTP 500",
  };
}

// ---------------------------------------------------------------------------
// jsonpath
// ---------------------------------------------------------------------------

describe("getPath", () => {
  const body = { loads: [{ pods: [{ id: "p1" }, { id: "p2" }] }], meta: { total: 1 } };

  it("returns obj on empty path", () => {
    expect(getPath(body, "")).toBe(body);
  });

  it("walks nested objects", () => {
    expect(getPath(body, "meta.total")).toBe(1);
  });

  it("indexes arrays with numeric segments", () => {
    expect(getPath(body, "loads.0.pods")).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect(getPath(body, "loads.0.pods.1.id")).toBe("p2");
  });

  it("returns undefined on any miss", () => {
    expect(getPath(body, "nope")).toBeUndefined();
    expect(getPath(body, "meta.total.deeper")).toBeUndefined(); // through primitive
    expect(getPath(body, "loads.5")).toBeUndefined(); // out of range
    expect(getPath(body, "loads.pods")).toBeUndefined(); // non-numeric on array
    expect(getPath({ a: null }, "a.b")).toBeUndefined(); // through null
  });

  it("returns null values as-is", () => {
    expect(getPath({ a: null }, "a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runChecks — http
// ---------------------------------------------------------------------------

describe("runChecks: http", () => {
  it("count passes on matching array length and resolves relative urls", async () => {
    const requested: string[] = [];
    const driver = makeDriver({
      contextGet: async (url) => {
        requested.push(url);
        return { status: 200, body: JSON.stringify({ loads: [{ pods: [{}] }] }) };
      },
    });
    const [r] = await runChecks(
      [{ type: "http", url: "/api/loads", path: "loads.0.pods", count: 1 }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.passed).toBe(true);
    expect(r?.errored).toBe(false);
    expect(r?.attempts).toBe(1);
    expect(requested[0]).toBe("http://app.local/api/loads");
  });

  it("count mismatch fails as assertion and polls up to 8 times (attempts 9)", async () => {
    const driver = makeDriver({
      contextGet: async () => ({ status: 200, body: JSON.stringify({ pods: [{}, {}] }) }),
    });
    const [r] = await runChecks(
      [{ type: "http", url: "/api/pods", path: "pods", count: 1 }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.passed).toBe(false);
    expect(r?.errored).toBe(false);
    expect(r?.attempts).toBe(9); // 1 initial + 8 polls
    expect(r?.detail).toContain("expected count 1, got 2");
  });

  it("equals is deep equality independent of key order", async () => {
    const driver = makeDriver({
      contextGet: async () => ({ status: 200, body: '{"cfg":{"b":2,"a":{"y":1,"x":[1,2]}}}' }),
    });
    const [r] = await runChecks(
      [{ type: "http", url: "/api/cfg", path: "cfg", equals: { a: { x: [1, 2], y: 1 }, b: 2 } }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.passed).toBe(true);
  });

  it("equals mismatch fails with expected detail", async () => {
    const driver = makeDriver({
      contextGet: async () => ({ status: 200, body: '{"state":"open"}' }),
    });
    const [r] = await runChecks(
      [{ type: "http", url: "/api", path: "state", equals: "closed" }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.passed).toBe(false);
    expect(r?.errored).toBe(false);
    expect(r?.detail).toContain('"closed"');
    expect(r?.actual).toBe('"open"');
  });

  it("expectStatus alone is a valid assertion (non-JSON body ok)", async () => {
    const driver = makeDriver({
      contextGet: async () => ({ status: 404, body: "Not Found" }),
    });
    const [r] = await runChecks(
      [{ type: "http", url: "/api/deleted", expectStatus: 404 }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.passed).toBe(true);
    expect(r?.errored).toBe(false);
  });

  it("expectStatus mismatch is an assertion failure, not check_error", async () => {
    const driver = makeDriver({ contextGet: async () => ({ status: 200, body: "ok" }) });
    const results = await runChecks(
      [{ type: "http", url: "/api/deleted", expectStatus: 404 }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.errored).toBe(false);
    const ev = evaluate({
      checkResults: results,
      ending: "done",
      belief: null,
      observations: [],
      setupFailed: false,
    });
    expect(ev.failureKind).toBe("assertion");
  });

  it("non-2xx without expectStatus is errored (check_error), not polled", async () => {
    const driver = makeDriver({ contextGet: async () => ({ status: 500, body: "boom" }) });
    const results = await runChecks(
      [{ type: "http", url: "/api/loads", path: "loads", count: 1 }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(results[0]?.errored).toBe(true);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.detail).toBe("HTTP 500");
    expect(results[0]?.attempts).toBe(1); // errored checks are never polled
    const ev = evaluate({
      checkResults: results,
      ending: "done",
      belief: null,
      observations: [],
      setupFailed: false,
    });
    expect(ev.verdict).toBe("FAIL");
    expect(ev.failureKind).toBe("check_error");
  });

  it("missing path is errored with the path in the detail", async () => {
    const driver = makeDriver({ contextGet: async () => ({ status: 200, body: "{}" }) });
    const [r] = await runChecks(
      [{ type: "http", url: "/api", path: "loads.0", count: 1 }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.errored).toBe(true);
    expect(r?.detail).toContain("path not found");
    expect(r?.detail).toContain("loads.0");
  });

  it("invalid JSON body is errored", async () => {
    const driver = makeDriver({ contextGet: async () => ({ status: 200, body: "<html>" }) });
    const [r] = await runChecks(
      [{ type: "http", url: "/api", equals: 1 }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.errored).toBe(true);
    expect(r?.detail).toContain("not valid JSON");
  });

  it("count on a non-array is errored", async () => {
    const driver = makeDriver({ contextGet: async () => ({ status: 200, body: '{"pods":3}' }) });
    const [r] = await runChecks(
      [{ type: "http", url: "/api", path: "pods", count: 3 }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.errored).toBe(true);
    expect(r?.detail).toContain("requires an array");
  });

  it("a throwing contextGet is errored, never a crash", async () => {
    const driver = makeDriver({
      contextGet: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const [r] = await runChecks(
      [{ type: "http", url: "/api", count: 1 }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.errored).toBe(true);
    expect(r?.detail).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// runChecks — page checks
// ---------------------------------------------------------------------------

describe("runChecks: text / element", () => {
  it("polls a failing text check until it passes (mutable page)", async () => {
    let calls = 0;
    const driver = makeDriver({
      visibleText: async () => {
        calls += 1;
        return calls >= 3 ? "Upload   RECEIVED\n ok" : "loading";
      },
    });
    const [r] = await runChecks(
      [{ type: "text", contains: "upload received" }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.passed).toBe(true);
    expect(r?.attempts).toBe(3);
  });

  it("no_text passes when text is absent and fails when present", async () => {
    const absent = makeDriver({ visibleText: async () => "all good here" });
    const present = makeDriver({ visibleText: async () => "An ERROR occurred" });
    const [ok] = await runChecks(
      [{ type: "no_text", contains: "error" }],
      absent,
      "http://app.local",
      FAST,
    );
    const [bad] = await runChecks(
      [{ type: "no_text", contains: "error" }],
      present,
      "http://app.local",
      FAST,
    );
    expect(ok?.passed).toBe(true);
    expect(bad?.passed).toBe(false);
    expect(bad?.detail).toContain("unexpectedly present");
  });

  it("appends the check.at note when the agent ended elsewhere", async () => {
    const check: TextCheck = { type: "text", contains: "hello", at: "/loads" };
    const driver = makeDriver({
      visibleText: async () => "hello",
      currentUrl: () => "http://app.local/home",
    });
    const [r] = await runChecks([check], driver, "http://app.local", FAST);
    expect(r?.passed).toBe(true);
    expect(r?.detail).toContain("check.at=/loads");
    expect(r?.detail).toContain("http://app.local/home");
  });

  it("element passes when found and not occluded", async () => {
    const driver = makeDriver({
      perceive: async () => ({
        url: "http://app.local/",
        title: "App",
        textDigest: "",
        elements: [{ ref: "e1", role: "button", name: "Save changes", nth: 0 }],
      }),
    });
    const [r] = await runChecks(
      [{ type: "element", role: "button", name: "save" }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.passed).toBe(true);
  });

  it("an occluded element fails the element check", async () => {
    const driver = makeDriver({
      perceive: async () => ({
        url: "http://app.local/",
        title: "App",
        textDigest: "",
        elements: [{ ref: "e1", role: "button", name: "Save", occluded: true, nth: 0 }],
      }),
    });
    const [r] = await runChecks(
      [{ type: "element", role: "button", name: "Save" }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(r?.passed).toBe(false);
    expect(r?.errored).toBe(false);
    expect(r?.detail).toContain("occluded");
  });

  it("no_element negates presence (role exact, name containment)", async () => {
    const driver = makeDriver({
      perceive: async () => ({
        url: "http://app.local/",
        title: "App",
        textDigest: "",
        elements: [{ ref: "e1", role: "button", name: "Delete load", nth: 0 }],
      }),
    });
    const [present] = await runChecks(
      [{ type: "no_element", role: "button", name: "delete" }],
      driver,
      "http://app.local",
      FAST,
    );
    const [absent] = await runChecks(
      [{ type: "no_element", role: "button", name: "publish" }],
      driver,
      "http://app.local",
      FAST,
    );
    const [otherRole] = await runChecks(
      [{ type: "no_element", role: "link", name: "delete" }],
      driver,
      "http://app.local",
      FAST,
    );
    expect(present?.passed).toBe(false);
    expect(absent?.passed).toBe(true);
    expect(otherRole?.passed).toBe(true);
  });

  it("url check matches on substring of currentUrl", async () => {
    const driver = makeDriver({ currentUrl: () => "http://app.local/loads/38419" });
    const [ok, bad] = await runChecks(
      [
        { type: "url", contains: "/loads/" },
        { type: "url", contains: "/settings" },
      ],
      driver,
      "http://app.local",
      FAST,
    );
    expect(ok?.passed).toBe(true);
    expect(bad?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluate — the verdict matrix
// ---------------------------------------------------------------------------

describe("evaluate", () => {
  const base = { ending: "done" as const, belief: null, observations: [], setupFailed: false };

  it("setupFailed quarantines the run", () => {
    const ev = evaluate({ ...base, checkResults: [passResult()], setupFailed: true });
    expect(ev.verdict).toBe("SETUP_FAILED");
    expect(ev.failureKind).toBe("setup_failed");
    expect(ev.discrepancy).toBe(false);
    expect(ev.reverseDiscrepancy).toBe(false);
    expect(ev.passedWithObservations).toBe(false);
  });

  it("fatal ending is technical even with passing checks", () => {
    const ev = evaluate({
      ...base,
      checkResults: [passResult()],
      ending: "fatal",
      fatalError: "browser crashed",
    });
    expect(ev.verdict).toBe("FAIL");
    expect(ev.failureKind).toBe("technical");
    expect(ev.ending).toBe("fatal");
  });

  it("check_error takes precedence over assertion", () => {
    const ev = evaluate({ ...base, checkResults: [erroredResult(), failResult()] });
    expect(ev.verdict).toBe("FAIL");
    expect(ev.failureKind).toBe("check_error");
  });

  it("clean failing checks are assertion failures", () => {
    const ev = evaluate({ ...base, checkResults: [passResult(), failResult()] });
    expect(ev.verdict).toBe("FAIL");
    expect(ev.failureKind).toBe("assertion");
  });

  it("all passing checks is PASS with no failureKind", () => {
    const ev = evaluate({ ...base, checkResults: [passResult()] });
    expect(ev.verdict).toBe("PASS");
    expect(ev.failureKind).toBeUndefined();
  });

  it("discrepancy only on clean assertion failure with belief success", () => {
    const believer = { outcome: "success" as const, summary: "done it" };
    const assertion = evaluate({ ...base, checkResults: [failResult()], belief: believer });
    expect(assertion.discrepancy).toBe(true);

    const unsure = evaluate({
      ...base,
      checkResults: [failResult()],
      belief: { outcome: "unsure", summary: "maybe" },
    });
    expect(unsure.discrepancy).toBe(false);

    const errored = evaluate({ ...base, checkResults: [erroredResult()], belief: believer });
    expect(errored.discrepancy).toBe(false); // check_error never raises a discrepancy
  });

  it("reverseDiscrepancy on gave_up with passing checks", () => {
    const ev = evaluate({
      ...base,
      checkResults: [passResult()],
      ending: "gave_up",
      belief: { outcome: "failure", summary: "could not find the button" },
    });
    expect(ev.verdict).toBe("PASS");
    expect(ev.reverseDiscrepancy).toBe(true);
    expect(ev.discrepancy).toBe(false);
  });

  it("reverseDiscrepancy requires a belief", () => {
    const ev = evaluate({ ...base, checkResults: [passResult()], belief: null });
    expect(ev.reverseDiscrepancy).toBe(false);
  });

  it("passedWithObservations flags a PASS carrying error observations", () => {
    const errorObs = [{ kind: "http_error" as const, severity: "error" as const, message: "x" }];
    const pass = evaluate({ ...base, checkResults: [passResult()], observations: errorObs });
    expect(pass.passedWithObservations).toBe(true);

    const warnOnly = evaluate({
      ...base,
      checkResults: [passResult()],
      observations: [{ kind: "gave_up", severity: "warning", message: "y" }],
    });
    expect(warnOnly.passedWithObservations).toBe(false);

    const fail = evaluate({ ...base, checkResults: [failResult()], observations: errorObs });
    expect(fail.passedWithObservations).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// observers
// ---------------------------------------------------------------------------

describe("deriveObservations", () => {
  it("maps incidents to kinds and severities", () => {
    const steps = [
      makeStep(0, {
        incidents: {
          consoleDelta: [
            { level: "error", text: "Uncaught TypeError: x is not a function" },
            { level: "warning", text: "deprecated API" }, // non-error levels ignored
            { level: "log", text: "hello" },
          ],
          networkDelta: [
            { method: "GET", url: "http://app.local/api/a", status: 500 },
            { method: "GET", url: "http://app.local/api/b", status: 404 },
            { method: "POST", url: "http://app.local/api/c", status: -1 },
            { method: "GET", url: "http://app.local/api/d", status: 200 }, // fine
          ],
          dialogs: [{ dialogType: "confirm", message: "Delete this?", response: "accept" }],
        },
      }),
      makeStep(1, {
        action: { kind: "click", ref: "e1" },
        result: { ok: false, error: "node changed", errorKind: "stale_target" },
      }),
    ];
    const obs = deriveObservations(steps, "done", obsCfg());
    const byKind = (k: string) => obs.filter((o) => o.kind === k);

    expect(byKind("console_error")).toHaveLength(1);
    expect(byKind("console_error")[0]?.severity).toBe("error");
    expect(byKind("console_error")[0]?.stepIndex).toBe(0);

    const httpErrors = byKind("http_error");
    expect(httpErrors).toHaveLength(2);
    expect(httpErrors.find((o) => o.message.includes("500"))?.severity).toBe("error");
    expect(httpErrors.find((o) => o.message.includes("404"))?.severity).toBe("warning");

    expect(byKind("request_failed")).toHaveLength(1);
    expect(byKind("request_failed")[0]?.severity).toBe("warning");

    const action = byKind("action_error");
    expect(action).toHaveLength(1);
    expect(action[0]?.severity).toBe("warning"); // stale_target stays warning
    expect(action[0]?.message).toContain("stale_target");
    expect(action[0]?.stepIndex).toBe(1);

    expect(byKind("dialog_auto_handled")[0]?.severity).toBe("info");
    expect(byKind("dialog_auto_handled")[0]?.message).toContain("Delete this?");
  });

  it("applies built-in and configured console ignore patterns", () => {
    const steps = [
      makeStep(0, {
        incidents: {
          consoleDelta: [
            { level: "error", text: "GET http://app.local/favicon.ico 404" },
            { level: "error", text: "[HMR] connection lost" },
            { level: "error", text: "analytics beacon blocked" },
            { level: "error", text: "real problem" },
          ],
        },
      }),
    ];
    const obs = deriveObservations(steps, "done", obsCfg({ ignoreConsole: ["^analytics"] }));
    expect(obs).toHaveLength(1);
    expect(obs[0]?.message).toBe("real problem");
  });

  it("applies ignoreRequests substrings to failed and http-error requests", () => {
    const steps = [
      makeStep(0, {
        incidents: {
          networkDelta: [
            { method: "POST", url: "http://app.local/telemetry/hit", status: -1 },
            { method: "GET", url: "http://app.local/telemetry/err", status: 500 },
            { method: "GET", url: "http://app.local/api/real", status: 500 },
          ],
        },
      }),
    ];
    const obs = deriveObservations(steps, "done", obsCfg({ ignoreRequests: ["/telemetry"] }));
    expect(obs).toHaveLength(1);
    expect(obs[0]?.message).toContain("/api/real");
  });

  it("dedupes identical (kind,message) pairs keeping the first stepIndex", () => {
    const entry = { level: "error" as const, text: "boom" };
    const steps = [
      makeStep(2, { incidents: { consoleDelta: [entry] } }),
      makeStep(3, { incidents: { consoleDelta: [entry] } }),
      makeStep(4, { incidents: { consoleDelta: [entry] } }),
    ];
    const obs = deriveObservations(steps, "done", obsCfg());
    expect(obs).toHaveLength(1);
    expect(obs[0]?.message).toBe("boom (x3)");
    expect(obs[0]?.stepIndex).toBe(2);
  });

  it("records gave_up with the agent's reason from the last step", () => {
    const steps = [
      makeStep(0),
      makeStep(1, { action: { kind: "give_up", reason: "cannot find the upload button" } }),
    ];
    const obs = deriveObservations(steps, "gave_up", obsCfg());
    const gaveUp = obs.find((o) => o.kind === "gave_up");
    expect(gaveUp?.severity).toBe("warning");
    expect(gaveUp?.message).toBe("cannot find the upload button");
    expect(gaveUp?.stepIndex).toBe(1);
  });

  it("records max_steps", () => {
    const obs = deriveObservations([makeStep(0), makeStep(1)], "max_steps", obsCfg());
    const maxed = obs.find((o) => o.kind === "max_steps");
    expect(maxed?.severity).toBe("warning");
    expect(maxed?.message).toContain("2 steps");
  });

  it("throws a readable error on an invalid ignoreConsole regex", () => {
    expect(() => deriveObservations([], "done", obsCfg({ ignoreConsole: ["[unclosed"] }))).toThrow(
      /ignoreConsole.*\[unclosed/,
    );
  });
});
