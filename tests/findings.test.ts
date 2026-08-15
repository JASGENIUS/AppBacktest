import { describe, expect, it } from "vitest";
import { Redactor } from "../src/core/redaction";
import { buildFindings, buildTimeline, formatOffset, sortFindings } from "../src/findings";
import { buildUxFindings } from "../src/ux";
import { correlateSource } from "../src/findings/source";
import { renderReplayHtml } from "../src/reporting/replayHtml";
import { resolvePersona } from "../src/core/worldgen";
import type {
  AgentAction,
  Finding,
  IncidentDrain,
  ReplayConfig,
  RunRecord,
  StepRecord,
  UxConfig,
} from "../src/core/types";

const REPLAY: ReplayConfig = { beforeMs: 20000, afterMs: 10000 };
const UX: UxConfig = { level: "conservative", minConfidence: 0.7, maxRecommendations: 3 };
const runDirOf = (r: RunRecord) => `runs/${r.runId}`;

const T0 = Date.parse("2026-08-14T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function emptyIncidents(): IncidentDrain {
  return {
    consoleDelta: [],
    networkDelta: [],
    transientMessages: [],
    transientEvents: [],
    dialogs: [],
    tabSwitched: false,
  };
}

function step(
  index: number,
  action: AgentAction,
  atMs: number,
  opts: { targetName?: string; incidents?: Partial<IncidentDrain>; ok?: boolean; url?: string } = {},
): StepRecord {
  return {
    index,
    elapsedMs: 500,
    preUrl: opts.url ?? "http://localhost:4174/new",
    perceptionDigest: `d${index}`,
    perception: { title: "Cove", elementCount: 5 },
    action,
    ...(opts.targetName ? { target: { role: "button", name: opts.targetName, nth: 0 } } : {}),
    perturbations: [],
    incidents: { ...emptyIncidents(), ...opts.incidents },
    result: { ok: opts.ok ?? true, urlAfter: opts.url ?? "http://localhost:4174/new" },
    screenshot: `steps/${String(index).padStart(3, "0")}.png`,
    tsStart: iso(atMs),
    tsEnd: iso(atMs + 300),
  };
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    formatVersion: 1,
    appbacktestVersion: "0.0.0-test",
    runId: "run-1",
    seed: "s",
    subSeed: "s:sc:0",
    scenarioKey: "submit_expense",
    personaKey: "employee",
    goal: "submit an expense",
    world: { persona: resolvePersona({}) },
    provider: { type: "fixture" },
    app: { name: "Cove", url: "http://localhost:4174" },
    configHash: "hash",
    checks: [],
    startedAt: iso(0),
    finishedAt: iso(20000),
    steps: [],
    observations: [],
    evaluation: {
      verdict: "PASS",
      ending: "done",
      checkResults: [],
      agentBelief: { outcome: "success", summary: "did it" },
      discrepancy: false,
      reverseDiscrepancy: false,
      passedWithObservations: false,
    },
    ...over,
  };
}

describe("redaction (capture-time)", () => {
  const r = new Redactor({
    enabled: true,
    fieldPatterns: ["password", "api[\\s_-]?key"],
    valuePatterns: ["\\bsk-[A-Za-z0-9]{6,}"],
    mask: "[redacted]",
  });

  it("flags password inputs and sensitive-looking field names", () => {
    expect(r.isSensitiveField("anything", "password")).toBe(true);
    expect(r.isSensitiveField("API Key")).toBe(true);
    expect(r.isSensitiveField("Delivery notes")).toBe(false);
  });

  it("masks credential-shaped values in free text", () => {
    expect(r.text("token is sk-abcdef123456 ok")).toBe("token is [redacted] ok");
    expect(r.text("nothing secret here")).toBe("nothing secret here");
  });

  it("masks sensitive query parameters by name, keeping the URL usable", () => {
    const out = r.url("http://app.test/cb?code=1&api_key=hunter2");
    expect(out).toContain("code=1");
    expect(out).not.toContain("hunter2");
  });

  it("is fully inert when disabled", () => {
    const off = new Redactor({ enabled: false, fieldPatterns: ["password"], valuePatterns: [], mask: "x" });
    expect(off.isSensitiveField("password")).toBe(false);
    expect(off.text("sk-abcdef123456")).toBe("sk-abcdef123456");
  });
});

describe("timeline", () => {
  it("merges actions and events onto one clock, in order", () => {
    const rec = record({
      steps: [
        step(0, { kind: "click", ref: "e1" }, 0, { targetName: "Submit" }),
        step(1, { kind: "wait", ms: 500 }, 2000, {
          incidents: {
            networkDelta: [{ method: "POST", url: "http://localhost:4174/api/x", status: 500, atMs: T0 + 2100 }],
            transientEvents: [{ text: "Something went wrong", atMs: T0 + 2300 }],
            transientMessages: ["Something went wrong"],
          },
        }),
      ],
    });
    const tl = buildTimeline(rec);
    expect(tl.map((e) => e.kind)).toEqual(["action", "action", "network", "transient"]);
    expect(tl[0]!.atMs).toBe(0);
    expect(tl[2]!.atMs).toBe(2100);
    expect(tl[2]!.label).toContain("500");
    expect(tl[3]!.label).toContain("Something went wrong");
  });

  it("formats offsets as mm:ss.mmm", () => {
    expect(formatOffset(6184)).toBe("00:06.184");
    expect(formatOffset(75000)).toBe("01:15.000");
  });
});

describe("findings", () => {
  it("turns a discrepancy into a critical finding with reproduction and a clip", () => {
    const rec = record({
      steps: [
        step(0, { kind: "click", ref: "e1" }, 0, { targetName: "New expense" }),
        step(1, { kind: "type", ref: "e2", text: "Client lunch" }, 1000),
        step(2, { kind: "done", outcome: "success", summary: "saved" }, 2000),
      ],
      evaluation: {
        verdict: "FAIL",
        failureKind: "assertion",
        ending: "done",
        checkResults: [
          {
            check: { type: "http", url: "/api/expenses", path: "2.category", equals: "meals" },
            passed: false,
            errored: false,
            actual: "uncategorized",
          },
        ],
        agentBelief: { outcome: "success", summary: "saved as Meals" },
        discrepancy: true,
        reverseDiscrepancy: false,
        passedWithObservations: false,
      },
    });
    const findings = buildFindings({ records: [rec], replay: REPLAY, runDirOf });
    const f = findings.find((x) => x.category === "critical_failure");
    expect(f).toBeTruthy();
    expect(f!.confidence).toBeGreaterThan(0.9);
    expect(f!.reproduction.join(" ")).toContain("New expense");
    expect(f!.evidence[0]).toContain("uncategorized");
    expect(f!.occurrences[0]!.clip).toBeTruthy();
    expect(f!.sourceModified).toBe(false);
  });

  it("groups repeat sightings into one finding and raises confidence", () => {
    const failing = (id: string) =>
      record({
        runId: id,
        steps: [step(0, { kind: "click", ref: "e1" }, 0, { targetName: "Pay" })],
        evaluation: {
          verdict: "FAIL",
          failureKind: "assertion",
          ending: "done",
          checkResults: [
            { check: { type: "text", contains: "Confirmed" }, passed: false, errored: false },
          ],
          agentBelief: null,
          discrepancy: false,
          reverseDiscrepancy: false,
          passedWithObservations: false,
        },
      });
    const one = buildFindings({ records: [failing("a")], replay: REPLAY, runDirOf });
    const three = buildFindings({
      records: [failing("a"), failing("b"), failing("c")],
      replay: REPLAY,
      runDirOf,
    });
    expect(three).toHaveLength(1);
    expect(three[0]!.occurrences).toHaveLength(3);
    expect(three[0]!.reproducedIn).toBe("3 / 3 attempts");
    expect(three[0]!.confidence).toBeGreaterThan(one[0]!.confidence);
  });

  it("reports 5xx responses as critical failures", () => {
    const rec = record({
      steps: [
        step(0, { kind: "click", ref: "e1" }, 0, {
          targetName: "Pay",
          incidents: {
            networkDelta: [
              { method: "POST", url: "http://localhost:4174/api/checkout", status: 500, atMs: T0 + 100 },
            ],
          },
        }),
      ],
    });
    const findings = buildFindings({ records: [rec], replay: REPLAY, runDirOf });
    expect(findings.some((f) => f.category === "critical_failure" && /500/.test(f.title))).toBe(true);
  });

  it("orders problems before recommendations", () => {
    const mk = (category: Finding["category"], severity: Finding["severity"]): Finding => ({
      id: category,
      category,
      severity,
      confidence: 0.8,
      title: category,
      observed: "",
      reproduction: [],
      evidence: [],
      occurrences: [],
      reproducedIn: "1 / 1 attempts",
      codeRefs: [],
      sourceModified: false,
    });
    const sorted = sortFindings([
      mk("qol_recommendation", "low"),
      mk("critical_failure", "critical"),
      mk("usability", "medium"),
      mk("functional_bug", "high"),
    ]);
    expect(sorted.map((f) => f.category)).toEqual([
      "critical_failure",
      "functional_bug",
      "usability",
      "qol_recommendation",
    ]);
  });
});

describe("ux recommendations", () => {
  /** The spec's own example: content saved, confirmed, then nowhere to be seen. */
  const notDiscoverable = () =>
    record({
      steps: [
        step(0, { kind: "click", ref: "e1" }, 0, { targetName: "Add note" }),
        step(1, { kind: "type", ref: "e2", text: "Lunch with client" }, 1000),
        step(2, { kind: "click", ref: "e3" }, 2000, {
          targetName: "Save note",
          incidents: {
            transientMessages: ["Note added"],
            transientEvents: [{ text: "Note added", atMs: T0 + 2100 }],
          },
        }),
        step(3, { kind: "click", ref: "e4" }, 3000, { targetName: "Back" }),
        step(4, { kind: "done", outcome: "success", summary: "added the note" }, 4000),
      ],
    });

  it("reports saved-but-invisible content as a usability issue, not a bug", () => {
    const findings = buildUxFindings({ records: [notDiscoverable()], ux: UX, replay: REPLAY, runDirOf });
    const f = findings.find((x) => /hard to find/i.test(x.title));
    expect(f).toBeTruthy();
    expect(f!.category).toBe("usability");
    expect(f!.suggestion).toBeTruthy();
    expect(f!.userImpact).toBeTruthy();
    expect(f!.observed).toContain("Note added");
    expect(f!.occurrences[0]!.clip).toBeTruthy();
  });

  it("is completely disableable", () => {
    const off = buildUxFindings({
      records: [notDiscoverable()],
      ux: { ...UX, level: "off" },
      replay: REPLAY,
      runDirOf,
    });
    expect(off).toEqual([]);
  });

  it("honours the confidence threshold and the hard cap", () => {
    const strict = buildUxFindings({
      records: [notDiscoverable()],
      ux: { ...UX, minConfidence: 0.99 },
      replay: REPLAY,
      runDirOf,
    });
    expect(strict).toEqual([]);

    const capped = buildUxFindings({
      records: [notDiscoverable()],
      ux: { ...UX, maxRecommendations: 0 },
      replay: REPLAY,
      runDirOf,
    });
    expect(capped).toEqual([]);
  });

  it("stays quiet on a clean run — no opinions without friction", () => {
    const clean = record({
      steps: [
        step(0, { kind: "click", ref: "e1" }, 0, {
          targetName: "Submit",
          incidents: {
            transientMessages: ["Saved"],
            transientEvents: [{ text: "Saved", atMs: T0 + 100 }],
          },
          url: "http://localhost:4174/done",
        }),
        step(1, { kind: "done", outcome: "success", summary: "ok" }, 1000),
      ],
    });
    expect(buildUxFindings({ records: [clean], ux: UX, replay: REPLAY, runDirOf })).toEqual([]);
  });

  it("never blames the app when the model or harness was what broke", () => {
    const rec = record({
      steps: [
        step(0, { kind: "give_up", reason: "provider produced an invalid action twice: no JSON object found" }, 0),
      ],
      evaluation: {
        verdict: "PASS",
        ending: "gave_up",
        checkResults: [],
        agentBelief: { outcome: "failure", summary: "provider produced an invalid action twice" },
        discrepancy: false,
        reverseDiscrepancy: true,
        passedWithObservations: false,
      },
    });
    expect(buildUxFindings({ records: [rec], ux: UX, replay: REPLAY, runDirOf })).toEqual([]);
  });

  it("treats feedback arriving on the next step as feedback the user saw", () => {
    const rec = record({
      steps: [
        step(0, { kind: "click", ref: "e1" }, 0, { targetName: "Submit expense" }),
        // The toast lands ~350ms later, so it drains on the following step.
        step(1, { kind: "wait", ms: 500 }, 1000, {
          incidents: {
            transientMessages: ["Expense submitted"],
            transientEvents: [{ text: "Expense submitted", atMs: T0 + 1100 }],
          },
        }),
        step(2, { kind: "done", outcome: "success", summary: "ok" }, 2000),
      ],
    });
    const findings = buildUxFindings({ records: [rec], ux: UX, replay: REPLAY, runDirOf });
    expect(findings.some((f) => /No visible confirmation/i.test(f.title))).toBe(false);
  });

  it("flags a workflow that worked but left the user unsure (reverse discrepancy)", () => {
    const rec = record({
      steps: [step(0, { kind: "give_up", reason: "could not confirm it saved" }, 0)],
      evaluation: {
        verdict: "PASS",
        ending: "gave_up",
        checkResults: [],
        agentBelief: { outcome: "failure", summary: "could not confirm" },
        discrepancy: false,
        reverseDiscrepancy: true,
        passedWithObservations: false,
      },
    });
    const findings = buildUxFindings({ records: [rec], ux: UX, replay: REPLAY, runDirOf });
    expect(findings.some((f) => /could not tell/i.test(f.title))).toBe(true);
  });
});

describe("source correlation (read-only)", () => {
  it("does nothing when disabled", () => {
    const findings = buildFindings({ records: [record()], replay: REPLAY, runDirOf });
    const out = correlateSource(findings, { enabled: false, maxFiles: 10 });
    expect(out.every((f) => f.codeRefs.length === 0)).toBe(true);
  });

  it("links a failing endpoint to the file that mentions it", () => {
    const rec = record({
      steps: [
        step(0, { kind: "click", ref: "e1" }, 0, {
          targetName: "Submit expense",
          incidents: {
            networkDelta: [
              { method: "POST", url: "http://localhost:4174/api/expenses", status: 500, atMs: T0 + 50 },
            ],
          },
        }),
      ],
    });
    const findings = buildFindings({ records: [rec], replay: REPLAY, runDirOf });
    // Point it at this repo's own example app, which really does serve that route.
    const out = correlateSource(findings, {
      enabled: true,
      root: "examples/expense-app",
      maxFiles: 200,
    });
    const withRefs = out.find((f) => f.codeRefs.length > 0);
    expect(withRefs, "expected a code reference for /api/expenses").toBeTruthy();
    expect(withRefs!.codeRefs[0]!.path).toMatch(/\.(js|ts)$/);
    expect(withRefs!.codeRefs[0]!.why).toBeTruthy();
    // The invariant that matters most:
    expect(out.every((f) => f.sourceModified === false)).toBe(true);
  });
});

describe("replay viewer", () => {
  it("renders a self-contained page with the timeline and finding markers", () => {
    const rec = record({
      steps: [
        step(0, { kind: "click", ref: "e1" }, 0, { targetName: "Pay" }),
        step(1, { kind: "done", outcome: "success", summary: "paid" }, 1000),
      ],
      evaluation: {
        verdict: "FAIL",
        failureKind: "assertion",
        ending: "done",
        checkResults: [{ check: { type: "text", contains: "Confirmed" }, passed: false, errored: false }],
        agentBelief: { outcome: "success", summary: "paid" },
        discrepancy: true,
        reverseDiscrepancy: false,
        passedWithObservations: false,
      },
    });
    const findings = buildFindings({ records: [rec], replay: REPLAY, runDirOf });
    const html = renderReplayHtml(rec, findings);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("steps/000.png");
    expect(html).toContain("jump to finding");
    expect(html).toContain("discrepancy");
    // No external requests — must work from file://
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/<script src=/);
  });
});
