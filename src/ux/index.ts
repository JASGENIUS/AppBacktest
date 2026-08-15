/**
 * UX & quality-of-life findings.
 *
 * The hard rule from the spec: a recommendation must come from friction
 * actually encountered while using the app — never from an AI deciding a
 * button should be a different colour. That is enforced structurally, not by
 * prompting:
 *
 *   1. Deterministic SIGNALS fire only when recorded evidence matches a
 *      specific friction pattern (created-but-not-visible, no feedback after
 *      a submit, repeated navigation, retry loops, gave-up-but-worked…).
 *   2. Each signal already carries its own observed/impact/suggestion text and
 *      its evidence and timestamp.
 *   3. Nothing else can become a recommendation. There is no path from "the
 *      model had an idea" to a finding — the LLM is not consulted at all.
 *
 * Conservatism is a threshold on top: level + minConfidence + a hard cap, so
 * developers get three meaningful notes rather than thirty speculative ones.
 */

import { sha256 } from "../core/hash";
import type {
  Finding,
  FindingOccurrence,
  ReplayConfig,
  RunRecord,
  UxConfig,
  UxLevel,
} from "../core/types";
import { buildClip, buildTimeline, offsetOfStep } from "./../findings/timeline";

interface Signal {
  key: string;
  title: string;
  observed: string;
  userImpact: string;
  suggestion: string;
  confidence: number;
  severity: "medium" | "low" | "info";
  category: "usability" | "qol_recommendation";
  evidence: string[];
  atMs?: number;
  /** Lowest level at which this signal is allowed to surface. */
  minLevel: UxLevel;
}

const LEVEL_RANK: Record<UxLevel, number> = { off: 0, conservative: 1, balanced: 2, detailed: 3 };

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Actions that a user would consider "committing" something. */
function isCommitAction(label: string): boolean {
  return /save|submit|add|create|upload|send|apply|confirm|pay|post/i.test(label);
}

/**
 * Signal: the user successfully created something, the app confirmed it, but
 * the created content never appeared anywhere they could see afterwards.
 * This is the spec's own worked example (the saved note nobody can find).
 */
function createdButNotVisible(record: RunRecord): Signal | null {
  const confirmations: Array<{ text: string; stepIndex: number }> = [];
  for (const step of record.steps) {
    for (const t of step.incidents.transientMessages) {
      if (/added|saved|created|submitted|uploaded/i.test(t)) {
        confirmations.push({ text: t, stepIndex: step.index });
      }
    }
  }
  if (confirmations.length === 0) return null;

  // What did the user actually put in? Look for typed content committed
  // shortly before a confirmation.
  const typed: Array<{ text: string; stepIndex: number }> = [];
  for (const step of record.steps) {
    if (step.action.kind === "type" && step.action.text.trim().length >= 6) {
      typed.push({ text: step.action.text.trim(), stepIndex: step.index });
    }
  }
  if (typed.length === 0) return null;

  const confirmed = confirmations[confirmations.length - 1]!;
  // Only consider content entered BEFORE the confirmation.
  const candidates = typed.filter((t) => t.stepIndex <= confirmed.stepIndex);
  if (candidates.length === 0) return null;
  const content = candidates[candidates.length - 1]!;
  if (content.text.startsWith("[redacted")) return null;

  // Did that content ever show up in a later perception's text digest?
  const laterDigests = record.steps
    .filter((s) => s.index > confirmed.stepIndex)
    .map((s) => norm(s.perception.title));
  const contentSeenLater = laterDigests.some((d) => d.includes(norm(content.text).slice(0, 20)));
  if (contentSeenLater) return null;
  // Needs somewhere to have looked: at least one step after the confirmation.
  if (record.steps.filter((s) => s.index > confirmed.stepIndex).length === 0) return null;

  return {
    key: "ux:created-not-visible",
    title: "Saved content is hard to find afterwards",
    observed:
      `The simulated user entered “${content.text.slice(0, 60)}” and the application confirmed it with ` +
      `“${confirmed.text}”. Continuing to use the application, that content was not visible on any screen ` +
      `the user reached afterwards.`,
    userImpact:
      "Users may be unsure whether their input was really saved, or where to go to see it again.",
    suggestion:
      "Consider showing the saved content on the screen it belongs to, or providing a clearly visible way to reach it.",
    confidence: 0.75,
    severity: "medium",
    category: "usability",
    evidence: [`app confirmed: “${confirmed.text}”`, `entered content: “${content.text.slice(0, 80)}”`],
    atMs: offsetOfStep(record, confirmed.stepIndex),
    minLevel: "conservative",
  };
}

/**
 * Signal: a commit-style action produced no visible feedback at all — no
 * message, no navigation, no dialog.
 */
function noFeedbackAfterCommit(record: RunRecord): Signal | null {
  for (const step of record.steps) {
    const label = step.target?.name ?? "";
    if (step.action.kind !== "click" || !isCommitAction(label)) continue;
    if (!step.result.ok) continue;
    const inc = step.incidents;
    const quiet =
      inc.transientMessages.length === 0 &&
      inc.dialogs.length === 0 &&
      step.result.urlAfter === step.preUrl;
    if (!quiet) continue;
    // Only meaningful if the user then kept going (i.e. had to figure it out).
    const after = record.steps.filter((s) => s.index > step.index);
    if (after.length === 0) continue;

    // The screen may well have responded without a toast: an in-page modal
    // opening, or a chunk of new controls appearing, IS visible feedback.
    // Reporting those as "no confirmation" would be exactly the unfounded
    // recommendation this system must never produce.
    const next = after[0]!;
    const modalAppeared = !step.perception.modalOpen && Boolean(next.perception.modalOpen);
    const elementDelta = Math.abs(next.perception.elementCount - step.perception.elementCount);
    const titleChanged = next.perception.title !== step.perception.title;
    if (modalAppeared || titleChanged || elementDelta >= 2) continue;
    // Server-rendered feedback often lands a few hundred ms after the click —
    // i.e. on the NEXT step's drain. That is still feedback the user saw.
    if (next.incidents.transientMessages.length > 0 || next.incidents.dialogs.length > 0) continue;
    if (next.result.urlAfter !== step.result.urlAfter) continue;
    return {
      key: `ux:no-feedback:${norm(label)}`,
      title: `No visible confirmation after “${label}”`,
      observed:
        `The user clicked “${label}” and the action succeeded, but nothing on screen changed: no message ` +
        `appeared, no dialog opened, and the page stayed at ${step.preUrl}.`,
      userImpact:
        "Users cannot tell whether the action worked, and may repeat it or abandon the workflow.",
      suggestion: "Consider confirming the result of this action visibly, or reflecting it in the page.",
      confidence: 0.72,
      severity: "medium",
      category: "usability",
      evidence: [`clicked “${label}” with no message, dialog, or navigation`],
      atMs: offsetOfStep(record, step.index),
      minLevel: "conservative",
    };
  }
  return null;
}

/**
 * Signal: the user gave up (or reported failure) on a workflow that the
 * checks say actually worked. The app succeeded but failed to communicate it.
 */
/** Give-ups caused by AppBacktest itself, not by the application's design. */
function isHarnessFailure(reason: string): boolean {
  return /provider (produced|refused|error)|invalid action|no JSON object|rate limit|fixture (exhausted|target not found)|API key|unknown ref/i.test(
    reason,
  );
}

function succeededButUserUnsure(record: RunRecord): Signal | null {
  const ev = record.evaluation;
  if (!ev.reverseDiscrepancy) return null;
  // If the simulated user stopped because the model or the harness broke, the
  // application's clarity is not what we observed. Never blame the app for it.
  const last = record.steps[record.steps.length - 1];
  if (last?.action.kind === "give_up" && isHarnessFailure(last.action.reason)) return null;
  if (ev.agentBelief && isHarnessFailure(ev.agentBelief.summary)) return null;
  return {
    key: "ux:unclear-success",
    title: "Workflow succeeded but the user could not tell",
    observed:
      `Every verification of the application's state passed, yet the simulated user ended the workflow ` +
      `believing it had not worked` +
      (ev.agentBelief ? ` (“${ev.agentBelief.summary.slice(0, 120)}”)` : "") +
      `.`,
    userImpact: "Users may retry completed work, contact support, or abandon a task that actually succeeded.",
    suggestion:
      "Consider making the successful outcome unmistakable on screen at the point the user is looking.",
    confidence: 0.8,
    severity: "medium",
    category: "usability",
    evidence: ["all checks passed", `user's own conclusion: ${ev.ending}`],
    atMs: offsetOfStep(record, record.steps[record.steps.length - 1]?.index ?? 0),
    minLevel: "conservative",
  };
}

/** Signal: the same control was operated repeatedly, suggesting unclear state. */
function retryLoop(record: RunRecord): Signal | null {
  const counts = new Map<string, number[]>();
  for (const step of record.steps) {
    if (step.action.kind !== "click" || !step.target?.name) continue;
    const key = norm(step.target.name);
    const arr = counts.get(key) ?? [];
    arr.push(step.index);
    counts.set(key, arr);
  }
  for (const [key, indexes] of counts) {
    if (indexes.length < 3) continue;
    const label = record.steps.find((s) => norm(s.target?.name ?? "") === key)?.target?.name ?? key;
    return {
      key: `ux:retry-loop:${key}`,
      title: `Repeated attempts on “${label}”`,
      observed: `The user operated “${label}” ${indexes.length} times during a single workflow.`,
      userImpact:
        "Repeating a control usually means its effect was unclear — and repeated commits can create duplicates.",
      suggestion:
        "Consider making the result of this control obvious after the first use, and disabling it while it is working.",
      confidence: 0.7,
      severity: "low",
      category: "usability",
      evidence: [`“${label}” operated at steps ${indexes.join(", ")}`],
      atMs: offsetOfStep(record, indexes[indexes.length - 1]!),
      minLevel: "balanced",
    };
  }
  return null;
}

/** Signal: the same page was revisited many times — navigation confusion. */
function navigationChurn(record: RunRecord): Signal | null {
  const counts = new Map<string, number>();
  for (const step of record.steps) {
    const url = pathOnly(step.preUrl);
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  for (const [url, n] of counts) {
    if (n < 4) continue;
    return {
      key: `ux:nav-churn:${url}`,
      title: `Repeated returns to ${url}`,
      observed: `The user came back to ${url} ${n} times while trying to complete a single task.`,
      userImpact: "Bouncing between screens suggests the path to the goal is not obvious from where the user starts.",
      suggestion: "Consider surfacing the next step of this workflow directly on that screen.",
      confidence: 0.65,
      severity: "low",
      category: "qol_recommendation",
      evidence: [`${url} visited ${n} times in one workflow`],
      atMs: offsetOfStep(record, record.steps[record.steps.length - 1]?.index ?? 0),
      minLevel: "balanced",
    };
  }
  return null;
}

/** Signal: the user could not find a control and said so. */
function couldNotFindControl(record: RunRecord): Signal | null {
  const last = record.steps[record.steps.length - 1];
  if (!last || last.action.kind !== "give_up") return null;
  const reason = last.action.reason;
  if (isHarnessFailure(reason)) return null; // the model broke, not the UI
  if (!/not (listed|visible|found|available)|cannot (find|interact|locate)|no (obvious|visible|way)/i.test(reason)) {
    return null;
  }
  return {
    key: `ux:undiscoverable:${norm(reason).slice(0, 40)}`,
    title: "Needed functionality was not discoverable",
    observed: `The user abandoned the task, reporting: “${reason.slice(0, 160)}”.`,
    userImpact: "If the capability exists but cannot be found, users experience it as missing.",
    suggestion:
      "Consider making this step visible from the screen where users need it, rather than behind an unlabelled path.",
    confidence: 0.7,
    severity: "medium",
    category: "usability",
    evidence: [`user's stated reason: “${reason.slice(0, 160)}”`],
    atMs: offsetOfStep(record, last.index),
    minLevel: "conservative",
  };
}

function pathOnly(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

const DETECTORS = [
  createdButNotVisible,
  noFeedbackAfterCommit,
  succeededButUserUnsure,
  couldNotFindControl,
  retryLoop,
  navigationChurn,
];

export interface UxInput {
  records: RunRecord[];
  ux: UxConfig;
  replay: ReplayConfig;
  runDirOf: (record: RunRecord) => string;
}

/**
 * Build UX findings. Returns [] when the level is "off" — the whole system is
 * disableable without touching bug detection.
 */
export function buildUxFindings(input: UxInput): Finding[] {
  if (input.ux.level === "off") return [];
  const allowed = LEVEL_RANK[input.ux.level];

  const grouped = new Map<string, { signal: Signal; occurrences: FindingOccurrence[] }>();
  const attemptsByScenario = new Map<string, number>();

  for (const record of input.records) {
    attemptsByScenario.set(record.scenarioKey, (attemptsByScenario.get(record.scenarioKey) ?? 0) + 1);
    if (record.evaluation.verdict === "SETUP_FAILED") continue;
    const timeline = buildTimeline(record);
    const runDir = input.runDirOf(record);

    for (const detector of DETECTORS) {
      const signal = detector(record);
      if (!signal) continue;
      if (LEVEL_RANK[signal.minLevel] > allowed) continue;

      const occurrence: FindingOccurrence = {
        runId: record.runId,
        runDir,
        scenarioKey: record.scenarioKey,
        personaKey: record.personaKey,
        ...(signal.atMs !== undefined ? { atMs: signal.atMs } : {}),
        ...(signal.atMs !== undefined
          ? { clip: buildClip(record, runDir, signal.atMs, input.replay, timeline) }
          : {}),
      };
      const existing = grouped.get(signal.key);
      if (existing) existing.occurrences.push(occurrence);
      else grouped.set(signal.key, { signal, occurrences: [occurrence] });
    }
  }

  const findings: Finding[] = [];
  for (const [key, { signal, occurrences }] of grouped) {
    const hits = occurrences.length;
    // A grouped finding may span scenarios — count every run it could have
    // shown up in, not just the first scenario's.
    const scenarios = new Set(occurrences.map((o) => o.scenarioKey));
    const attempts = [...scenarios].reduce(
      (n, s) => n + (attemptsByScenario.get(s) ?? 0),
      0,
    );
    // Friction seen in several independent runs is far more credible.
    const confidence = Math.min(0.95, signal.confidence + Math.min(0.15, (hits - 1) * 0.05));
    if (confidence < input.ux.minConfidence) continue;

    findings.push({
      id: sha256(key).slice(0, 12),
      category: signal.category,
      severity: signal.severity,
      confidence,
      title: signal.title,
      observed: signal.observed,
      userImpact: signal.userImpact,
      suggestion: signal.suggestion,
      reproduction: [],
      evidence: signal.evidence,
      occurrences,
      reproducedIn: `${hits} / ${Math.max(attempts, hits)} attempts`,
      codeRefs: [],
      sourceModified: false,
    });
  }

  // Conservative by construction: highest-confidence few, hard-capped.
  return findings
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, input.ux.maxRecommendations);
}
