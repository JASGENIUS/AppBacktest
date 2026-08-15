/**
 * Findings — AppBacktest's interpretation of captured evidence.
 *
 * Separate from Evaluation (did the configured checks pass?). A finding says
 * what kind of problem this is, how sure we are, how to reproduce it, and
 * carries the replay clip that proves it. Detectors are DETERMINISTIC: every
 * finding here is derived from recorded evidence, never from an opinion.
 *
 * Repeat sightings group onto one finding by a stable id, so twenty runs of
 * the same broken checkout produce one finding with twenty occurrences —
 * and reproduction count raises confidence.
 */

import { sha256 } from "../core/hash";
import type {
  CheckResult,
  Finding,
  FindingCategory,
  FindingOccurrence,
  FindingSeverity,
  ReplayConfig,
  RunRecord,
  TimelineEntry,
} from "../core/types";
import { buildClip, buildTimeline, formatOffset, offsetOfStep, sessionStart } from "./timeline";

export { buildTimeline, buildClip, formatOffset } from "./timeline";

/** A finding before grouping — one sighting in one run. */
interface Draft {
  key: string; // stable identity for grouping
  category: FindingCategory;
  severity: FindingSeverity;
  baseConfidence: number;
  title: string;
  observed: string;
  expected?: string;
  evidence: string[];
  atMs?: number;
}

const MAX_REPRO_STEPS = 12;

/** The action trail a developer would follow to get here. */
function reproduction(record: RunRecord): string[] {
  const trail: string[] = [];
  for (const step of record.steps) {
    const a = step.action;
    if (a.kind === "done" || a.kind === "give_up" || a.kind === "wait") continue;
    const name = step.target?.name ? ` “${step.target.name}”` : "";
    if (a.kind === "navigate") trail.push(`Go to ${a.url}`);
    else if (a.kind === "click") trail.push(`Click${name}`);
    else if (a.kind === "type") trail.push(`Type “${a.text.slice(0, 30)}”${name ? ` into${name}` : ""}`);
    else if (a.kind === "select") trail.push(`Select “${a.value}”${name}`);
    else if (a.kind === "upload") trail.push(`Attach a file${name}`);
    else if (a.kind === "press") trail.push(`Press ${a.key}`);
    else if (a.kind === "scroll") trail.push(`Scroll ${a.direction}`);
  }
  return trail.length > MAX_REPRO_STEPS
    ? [...trail.slice(0, MAX_REPRO_STEPS), `… ${trail.length - MAX_REPRO_STEPS} more actions`]
    : trail;
}

function describeCheck(r: CheckResult): string {
  const c = r.check;
  switch (c.type) {
    case "http":
      return `${c.url}${c.path ? ` (${c.path})` : ""} — expected ${
        c.count !== undefined ? `count ${c.count}` : c.equals !== undefined ? JSON.stringify(c.equals) : `status ${c.expectStatus}`
      }, got ${JSON.stringify(r.actual)?.slice(0, 120) ?? "nothing"}`;
    case "text":
    case "no_text":
    case "transient":
      return `${c.type} “${c.contains}” — ${r.passed ? "found" : "not found"}`;
    case "element":
    case "no_element":
      return `${c.type} ${c.role} “${c.name}” — ${r.passed ? "found" : "not found"}`;
    case "url":
      return `url should contain “${c.contains}”, was ${JSON.stringify(r.actual)}`;
  }
}

/**
 * Derive findings from one run. Every branch is grounded in something the
 * framework actually recorded.
 */
function detect(record: RunRecord, timeline: TimelineEntry[]): Draft[] {
  const drafts: Draft[] = [];
  const base = sessionStart(record);
  const ev = record.evaluation;
  const scenario = record.scenarioKey;

  // --- Server errors seen on the wire ---
  for (const step of record.steps) {
    for (const n of step.incidents.networkDelta) {
      if (n.status >= 500 || n.status === -1) {
        drafts.push({
          key: `net:${scenario}:${n.method}:${pathOf(n.url)}:${n.status}`,
          category: n.status === -1 ? "functional_bug" : "critical_failure",
          severity: n.status === -1 ? "high" : "critical",
          baseConfidence: 0.9,
          title:
            n.status === -1
              ? `Request failed: ${n.method} ${pathOf(n.url)}`
              : `Server error ${n.status} on ${n.method} ${pathOf(n.url)}`,
          observed:
            n.status === -1
              ? `The request ${n.method} ${pathOf(n.url)} never completed while the simulated user was working.`
              : `${n.method} ${pathOf(n.url)} returned HTTP ${n.status} during the workflow.`,
          expected: "The request should succeed, or the interface should surface a recoverable error.",
          evidence: [`${n.method} ${n.url} → ${n.status === -1 ? "failed" : n.status}`],
          atMs: n.atMs !== undefined ? n.atMs - base : offsetOfStep(record, step.index),
        });
      }
    }
    // --- Uncaught JavaScript ---
    for (const c of step.incidents.consoleDelta) {
      if (c.level !== "error") continue;
      const isException = /^pageerror:/.test(c.text);
      if (!isException) continue;
      drafts.push({
        key: `exc:${scenario}:${normalizeError(c.text)}`,
        category: "functional_bug",
        severity: "high",
        baseConfidence: 0.85,
        title: `Uncaught exception: ${c.text.replace(/^pageerror:\s*/, "").slice(0, 70)}`,
        observed: `The page threw an uncaught exception while the simulated user was interacting with it.`,
        expected: "The interaction should not raise an unhandled error.",
        evidence: [c.text],
        atMs: c.atMs !== undefined ? c.atMs - base : offsetOfStep(record, step.index),
      });
    }
  }

  // --- The headline: belief contradicted by application state ---
  if (ev.discrepancy) {
    const failed = ev.checkResults.filter((r) => !r.passed && !r.errored);
    drafts.push({
      key: `discrepancy:${scenario}:${failed.map((f) => JSON.stringify(f.check)).join("|")}`,
      category: "critical_failure",
      severity: "critical",
      baseConfidence: 0.95,
      title: `Application reported success but state disagrees (${scenario})`,
      observed:
        `The simulated user completed the workflow and believed it succeeded` +
        (ev.agentBelief ? ` (“${ev.agentBelief.summary.slice(0, 120)}”)` : "") +
        `, but verification of the application's own state failed.`,
      expected: "What the interface reports and what the application stores should agree.",
      evidence: failed.map(describeCheck),
      atMs: lastActionOffset(record),
    });
  } else if (ev.verdict === "FAIL" && ev.failureKind === "assertion") {
    const failed = ev.checkResults.filter((r) => !r.passed && !r.errored);
    drafts.push({
      key: `assert:${scenario}:${failed.map((f) => JSON.stringify(f.check)).join("|")}`,
      category: "functional_bug",
      severity: "high",
      baseConfidence: 0.85,
      title: `Workflow did not reach its expected outcome (${scenario})`,
      observed: `The workflow ran to completion but the application's state did not match what the workflow should have produced.`,
      expected: "The workflow should leave the application in the expected state.",
      evidence: failed.map(describeCheck),
      atMs: lastActionOffset(record),
    });
  }

  // --- The executor refused to act on a changed element ---
  for (const step of record.steps) {
    if (step.result.errorKind === "stale_target") {
      drafts.push({
        key: `stale:${scenario}:${step.target?.role ?? "?"}:${step.target?.name ?? "?"}`,
        category: "functional_bug",
        severity: "medium",
        baseConfidence: 0.6,
        title: `Element changed underneath the user: “${step.target?.name ?? "unknown"}”`,
        observed:
          `The control the user was about to act on changed identity or disappeared between seeing it and clicking it. ` +
          `AppBacktest refused to dispatch rather than clicking the wrong thing.`,
        expected: "Controls should stay stable while the user is reaching for them.",
        evidence: [step.result.error ?? "target changed before dispatch"],
        atMs: offsetOfStep(record, step.index),
      });
    }
  }

  // --- Harness/setup, reported honestly rather than as an app bug ---
  if (ev.verdict === "SETUP_FAILED") {
    drafts.push({
      key: `setup:${scenario}`,
      category: "critical_failure",
      severity: "critical",
      baseConfidence: 0.99,
      title: "Test setup failed — the run could not be graded",
      observed: "The application state could not be reset before the run, so no result was produced.",
      evidence: record.observations.filter((o) => o.severity === "error").map((o) => o.message),
    });
  }

  return drafts;
}

function lastActionOffset(record: RunRecord): number {
  const last = record.steps[record.steps.length - 1];
  return last ? offsetOfStep(record, last.index) : 0;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.slice(0, 60);
  }
}

/** Strip ids/numbers so the same exception groups across runs. */
function normalizeError(text: string): string {
  return text.replace(/\d+/g, "#").slice(0, 120);
}

export interface FindingsInput {
  records: RunRecord[];
  replay: ReplayConfig;
  /** Maps a runId to its POSIX directory relative to outDir. */
  runDirOf: (record: RunRecord) => string;
}

/**
 * Build the grouped finding set for a whole session. Occurrences accumulate
 * per finding; confidence rises with reproduction because a defect seen five
 * times out of five is more certain than one seen once.
 */
export function buildFindings(input: FindingsInput): Finding[] {
  const grouped = new Map<string, { draft: Draft; occurrences: FindingOccurrence[] }>();
  const attemptsByScenario = new Map<string, number>();

  for (const record of input.records) {
    attemptsByScenario.set(record.scenarioKey, (attemptsByScenario.get(record.scenarioKey) ?? 0) + 1);
    const timeline = buildTimeline(record);
    const runDir = input.runDirOf(record);

    for (const draft of detect(record, timeline)) {
      const existing = grouped.get(draft.key);
      const occurrence: FindingOccurrence = {
        runId: record.runId,
        runDir,
        scenarioKey: record.scenarioKey,
        personaKey: record.personaKey,
        ...(draft.atMs !== undefined ? { atMs: draft.atMs } : {}),
        ...(draft.atMs !== undefined
          ? { clip: buildClip(record, runDir, draft.atMs, input.replay, timeline) }
          : {}),
      };
      if (existing) existing.occurrences.push(occurrence);
      else grouped.set(draft.key, { draft, occurrences: [occurrence] });
    }
  }

  const findings: Finding[] = [];
  for (const [key, { draft, occurrences }] of grouped) {
    const first = occurrences[0]!;
    // "7 / 20 attempts" — hits against every run this could have appeared in.
    const scenarios = new Set(occurrences.map((o) => o.scenarioKey));
    const attempts = [...scenarios].reduce((n, s) => n + (attemptsByScenario.get(s) ?? 0), 0);
    const hits = occurrences.length;
    // Repeat reproduction is corroboration: nudge confidence up, capped.
    const confidence = Math.min(0.99, draft.baseConfidence + Math.min(0.08, (hits - 1) * 0.03));
    const source = input.records.find((r) => r.runId === first.runId)!;

    findings.push({
      id: sha256(key).slice(0, 12),
      category: draft.category,
      severity: draft.severity,
      confidence,
      title: draft.title,
      observed: draft.observed,
      ...(draft.expected ? { expected: draft.expected } : {}),
      reproduction: reproduction(source),
      evidence: draft.evidence,
      occurrences,
      reproducedIn: `${hits} / ${Math.max(attempts, hits)} attempts`,
      codeRefs: [],
      sourceModified: false,
    });
  }

  return sortFindings(findings);
}

const CATEGORY_ORDER: FindingCategory[] = [
  "critical_failure",
  "functional_bug",
  "visual_bug",
  "performance",
  "usability",
  "qol_recommendation",
];
const SEVERITY_ORDER: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

/** Real problems first; recommendations last. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.confidence - a.confidence,
  );
}

export function countByCategory(findings: Finding[]): Record<FindingCategory, number> {
  const counts = {
    critical_failure: 0,
    functional_bug: 0,
    visual_bug: 0,
    performance: 0,
    usability: 0,
    qol_recommendation: 0,
  };
  for (const f of findings) counts[f.category] += 1;
  return counts;
}
