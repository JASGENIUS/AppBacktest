/**
 * Terminal output. Streams every step as it happens (a silent multi-minute
 * LLM run reads as hung), and keeps the report honest: discrepancies,
 * divergences, setup failures and passed-with-observations are surfaced,
 * never folded into a rosier number. No composite score by design.
 */

import pc from "picocolors";
import type {
  AgentAction,
  BacktestReport,
  RunPlan,
  RunRecord,
  StepRecord,
} from "../core/types";

function describeAction(action: AgentAction): string {
  switch (action.kind) {
    case "navigate":
      return `navigate ${action.url}`;
    case "click":
      return `click ${action.ref}`;
    case "type":
      return `type "${action.text.slice(0, 40)}" into ${action.ref}`;
    case "select":
      return `select "${action.value}" in ${action.ref}`;
    case "upload":
      return `upload via ${action.ref}`;
    case "press":
      return `press ${action.key}`;
    case "scroll":
      return `scroll ${action.direction}`;
    case "back":
      return "back";
    case "wait":
      return `wait ${action.ms}ms`;
    case "done":
      return `done (${action.outcome}): ${action.summary.slice(0, 80)}`;
    case "give_up":
      return `give up: ${action.reason.slice(0, 80)}`;
  }
}

export function printRunStart(plan: RunPlan): void {
  console.log(
    `\n${pc.bold("▶")} ${pc.bold(plan.scenarioKey)} ${pc.dim(`[${plan.personaKey}]`)} ${pc.dim(`sub-seed ${plan.subSeed}`)}`,
  );
}

export function printStepLine(step: StepRecord): void {
  const target = step.target ? ` ${pc.dim(`'${step.target.name}'`)}` : "";
  const head = `  #${step.index} ${describeAction(step.action)}${target}`;
  if (step.result.ok) {
    console.log(`${pc.dim(head)} ${pc.dim(`→ ok (${shortUrl(step.result.urlAfter)})`)}`);
  } else {
    console.log(`${head} ${pc.red(`✗ ${step.result.errorKind ?? "error"}: ${step.result.error ?? ""}`)}`);
  }
  for (const p of step.perturbations) {
    console.log(`    ${pc.yellow(`⚡ ${p.kind.replace("_", "-")}`)}`);
  }
  for (const t of step.incidents.transientMessages.slice(0, 3)) {
    console.log(`    ${pc.cyan(`💬 ${t.slice(0, 100)}`)}`);
  }
  for (const d of step.incidents.dialogs) {
    console.log(`    ${pc.cyan(`🔔 [${d.dialogType}] ${d.message.slice(0, 80)} → ${d.response}`)}`);
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function printRunEnd(record: RunRecord): void {
  const ev = record.evaluation;
  const verdictStr =
    ev.verdict === "PASS"
      ? pc.green(pc.bold("PASS"))
      : ev.verdict === "SETUP_FAILED"
        ? pc.magenta(pc.bold("SETUP_FAILED"))
        : pc.red(pc.bold(`FAIL (${ev.failureKind ?? "?"})`));
  console.log(`  ${verdictStr} ${pc.dim(`· ended: ${ev.ending} · ${record.steps.length} steps`)}`);

  if (ev.failureKind === "technical" || ev.verdict === "SETUP_FAILED") {
    const firstError = record.observations.find((o) => o.severity === "error");
    if (firstError) console.log(pc.red(`    ${firstError.message.slice(0, 200)}`));
  }

  if (ev.discrepancy) {
    console.log(pc.red(pc.bold("  ⚠ DISCREPANCY: the agent believed it succeeded — the application state says otherwise.")));
    if (record.evaluation.agentBelief) {
      console.log(pc.dim(`    agent: "${record.evaluation.agentBelief.summary.slice(0, 120)}"`));
    }
  }
  if (ev.reverseDiscrepancy) {
    console.log(pc.yellow("  ◀ REVERSE DISCREPANCY: the agent thought it failed, but every check passed (usability signal)."));
  }
  for (const r of ev.checkResults.filter((c) => !c.passed)) {
    const label = r.errored ? pc.magenta("check errored") : pc.red("check failed");
    console.log(`    ${label} ${JSON.stringify(r.check)}`);
    if (r.actual !== undefined) console.log(pc.dim(`      actual: ${JSON.stringify(r.actual).slice(0, 200)}`));
    if (r.detail) console.log(pc.dim(`      ${r.detail.slice(0, 200)}`));
  }
  if (ev.passedWithObservations) {
    console.log(pc.yellow("  ⚠ passed WITH error-severity observations — see evidence"));
  }
  if (ev.verdict === "FAIL") {
    console.log(pc.dim(`    evidence: .backtests/runs/${record.runId}/`));
    console.log(pc.dim(`    replay:   npx appbacktest replay ${record.runId}`));
    console.log(pc.dim(`    keep it:  npx appbacktest promote ${record.runId}`));
  }
}

export function printReport(report: BacktestReport, outDirAbs: string): void {
  const t = report.totals;
  console.log(`\n${pc.bold("─".repeat(60))}`);
  console.log(`${pc.bold("AppBacktest")} ${pc.dim(`· ${report.app.name} · seed ${report.seed} · config ${report.configHash.slice(0, 12)}`)}`);
  console.log(
    `  runs: ${t.total}   ${pc.green(`passed: ${t.passed}`)}   ${t.failed > 0 ? pc.red(`failed: ${t.failed}`) : pc.dim("failed: 0")}${t.setupFailed > 0 ? `   ${pc.magenta(`setup-failed: ${t.setupFailed}`)}` : ""}`,
  );
  if (t.discrepancies > 0) {
    console.log(pc.red(pc.bold(`  discrepancies: ${t.discrepancies} — agent belief contradicted by application state`)));
  }
  if (t.reverseDiscrepancies > 0) {
    console.log(pc.yellow(`  reverse discrepancies: ${t.reverseDiscrepancies}`));
  }
  if (t.passedWithObservations > 0) {
    console.log(pc.yellow(`  passed-with-observations: ${t.passedWithObservations}`));
  }
  const kinds = Object.entries(t.byFailureKind);
  if (kinds.length > 0) {
    console.log(pc.dim(`  failure kinds: ${kinds.map(([k, v]) => `${k}=${v}`).join("  ")}`));
  }
  console.log(pc.dim(`  report: ${outDirAbs.replace(/\\/g, "/")}/reports/latest.json`));
  console.log(pc.dim("  regressions are the gate: npx appbacktest regression"));
  console.log(pc.bold("─".repeat(60)));
}

export function printReplayResult(record: RunRecord): void {
  const outcome = record.replayOutcome ?? "INCONCLUSIVE";
  const style =
    outcome === "FIXED"
      ? pc.green(pc.bold("✓ FIXED"))
      : outcome === "REPRODUCED"
        ? pc.red(pc.bold("✗ REPRODUCED"))
        : outcome === "DIVERGED"
          ? pc.yellow(pc.bold("~ DIVERGED"))
          : pc.magenta(pc.bold("? INCONCLUSIVE"));
  console.log(`\n${style} ${pc.dim(`(replay of ${record.replayOf})`)}`);
  if (record.divergence) {
    const where = record.divergence.stepIndex >= 0 ? `step ${record.divergence.stepIndex}: ` : "";
    console.log(`  ${where}${record.divergence.reason}`);
    if (outcome === "DIVERGED") {
      console.log(pc.dim(`  UI changed too much to replay the trace — re-simulate live with:`));
      console.log(pc.dim(`    npx appbacktest run --seed ${record.seed}`));
    }
  }
  if (outcome === "REPRODUCED") {
    const failing = record.evaluation.checkResults.filter((r) => !r.passed);
    for (const r of failing) {
      console.log(pc.dim(`  still failing: ${JSON.stringify(r.check)} → actual ${JSON.stringify(r.actual).slice(0, 120)}`));
    }
  }
}
