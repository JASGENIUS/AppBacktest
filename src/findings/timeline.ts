/**
 * Timeline construction.
 *
 * A RunRecord already holds everything that happened — actions on steps,
 * events inside each step's incidents. This module merges them onto ONE clock
 * (ms since the session began) so a human can read, and scrub, the sequence:
 *
 *   00:00 navigated to /checkout
 *   00:02 clicked "Change shipping"
 *   00:05 POST /api/checkout -> 409
 *   00:06 console error
 *
 * Nothing here captures anything new; it is a pure view over existing
 * evidence, which keeps recording and presentation independent.
 */

import type { AgentAction, RunRecord, StepRecord, TimelineEntry } from "../core/types";

/** Session start as epoch ms. */
export function sessionStart(record: RunRecord): number {
  const first = Date.parse(record.startedAt);
  return Number.isFinite(first) ? first : 0;
}

function describeAction(action: AgentAction, targetName?: string): string {
  const on = targetName ? ` “${targetName}”` : "";
  switch (action.kind) {
    case "navigate":
      return `navigated to ${action.url}`;
    case "click":
      return `clicked${on || " an element"}`;
    case "type":
      return `typed “${action.text.slice(0, 60)}”${on ? ` into${on}` : ""}`;
    case "select":
      return `selected “${action.value}”${on}`;
    case "upload":
      return `attached a file${on}`;
    case "press":
      return `pressed ${action.key}`;
    case "scroll":
      return `scrolled ${action.direction}`;
    case "back":
      return "went back";
    case "wait":
      return `waited ${action.ms}ms`;
    case "done":
      return `finished — believed ${action.outcome}: ${action.summary.slice(0, 90)}`;
    case "give_up":
      return `gave up: ${action.reason.slice(0, 90)}`;
  }
}

/** Format ms as mm:ss.mmm, matching the report's failure timestamps. */
export function formatOffset(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = safe % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function stepOffset(record: RunRecord, step: StepRecord, base: number): number {
  const t = Date.parse(step.tsStart);
  return Number.isFinite(t) ? t - base : 0;
}

/**
 * Merge a run's actions and events into one ordered timeline.
 *
 * Events without their own timestamp (older records) fall back to the end of
 * the step they were drained on, so a v1 record still produces a usable
 * timeline rather than collapsing to zero.
 */
export function buildTimeline(record: RunRecord): TimelineEntry[] {
  const base = sessionStart(record);
  const entries: TimelineEntry[] = [];

  for (const step of record.steps) {
    const at = stepOffset(record, step, base);
    const stepEnd = Date.parse(step.tsEnd);
    const fallback = Number.isFinite(stepEnd) ? stepEnd - base : at;

    entries.push({
      atMs: at,
      kind: "action",
      stepIndex: step.index,
      // In a multi-user run, who did it is the most important part of the line.
      label: `${step.actor ? `${step.actor}: ` : ""}${describeAction(step.action, step.target?.name)}`,
      ...(step.screenshot ? { screenshot: step.screenshot } : {}),
      ...(step.perturbations.length > 0
        ? { detail: `perturbation: ${step.perturbations.map((p) => p.kind).join(", ")}` }
        : {}),
      severity: step.result.ok ? "info" : "warning",
    });

    if (!step.result.ok) {
      entries.push({
        atMs: fallback,
        kind: "error",
        stepIndex: step.index,
        label: `action failed (${step.result.errorKind ?? "error"})`,
        detail: step.result.error,
        severity: "warning",
      });
    }

    const inc = step.incidents;
    for (const n of inc.networkDelta) {
      entries.push({
        atMs: n.atMs !== undefined ? n.atMs - base : fallback,
        kind: "network",
        stepIndex: step.index,
        label: `${n.method} ${trimUrl(n.url)} → ${n.status === -1 ? "failed" : n.status}`,
        severity: n.status === -1 || n.status >= 500 ? "error" : "warning",
      });
    }
    for (const c of inc.consoleDelta) {
      entries.push({
        atMs: c.atMs !== undefined ? c.atMs - base : fallback,
        kind: "console",
        stepIndex: step.index,
        label: c.level === "error" ? "console error" : "console warning",
        detail: c.text,
        severity: c.level === "error" ? "error" : "warning",
      });
    }
    const transientEvents = inc.transientEvents;
    if (transientEvents && transientEvents.length > 0) {
      for (const t of transientEvents) {
        entries.push({
          atMs: t.atMs - base,
          kind: "transient",
          stepIndex: step.index,
          label: `app showed: “${t.text}”`,
          severity: "info",
        });
      }
    } else {
      for (const t of inc.transientMessages) {
        entries.push({
          atMs: fallback,
          kind: "transient",
          stepIndex: step.index,
          label: `app showed: “${t}”`,
          severity: "info",
        });
      }
    }
    for (const d of inc.dialogs) {
      entries.push({
        atMs: d.atMs !== undefined ? d.atMs - base : fallback,
        kind: "dialog",
        stepIndex: step.index,
        label: `${d.dialogType} dialog → ${d.response}`,
        detail: d.message,
        severity: "info",
      });
    }
  }

  entries.sort((a, b) => a.atMs - b.atMs || rank(a.kind) - rank(b.kind));
  return entries;
}

/** Actions sort before the events they caused when timestamps collide. */
function rank(kind: TimelineEntry["kind"]): number {
  return kind === "action" ? 0 : kind === "navigation" ? 1 : 2;
}

function trimUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search.slice(0, 40) : "");
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * Cut a clip around a moment of interest: everything within [focus-before,
 * focus+after]. Screenshots are referenced by relative path, never copied, so
 * clips stay cheap and the underlying run directory remains the single store.
 */
export function buildClip(
  record: RunRecord,
  runDir: string,
  focusMs: number,
  window: { beforeMs: number; afterMs: number },
  timeline?: TimelineEntry[],
): ReturnType<typeof makeClip> {
  const all = timeline ?? buildTimeline(record);
  return makeClip(record, runDir, focusMs, window, all);
}

function makeClip(
  record: RunRecord,
  runDir: string,
  focusMs: number,
  window: { beforeMs: number; afterMs: number },
  all: TimelineEntry[],
) {
  const startMs = Math.max(0, focusMs - window.beforeMs);
  const endMs = focusMs + window.afterMs;
  const entries = all.filter((e) => e.atMs >= startMs && e.atMs <= endMs);
  return {
    runId: record.runId,
    runDir,
    startMs,
    focusMs,
    endMs,
    // Always keep at least the surrounding action, even with a tight window.
    entries: entries.length > 0 ? entries : all.slice(-3),
  };
}

/** When did this step happen, in session-relative ms? */
export function offsetOfStep(record: RunRecord, stepIndex: number): number {
  const base = sessionStart(record);
  const step = record.steps.find((s) => s.index === stepIndex);
  if (!step) return 0;
  return stepOffset(record, step, base);
}
