import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AppBacktestConfig,
  BacktestReport,
  CheckConfig,
  Finding,
  ObservationKind,
  RunRecord,
  RunSummary,
} from "../core/types";
import { countByCategory } from "../findings";

export function buildReport(args: {
  records: RunRecord[];
  config: AppBacktestConfig;
  seed: string;
  configHashValue: string;
  appbacktestVersion: string;
  startedAt: string;
  finishedAt: string;
  findings?: Finding[];
}): BacktestReport {
  const { records, config } = args;

  const totals: BacktestReport["totals"] = {
    total: records.length,
    passed: 0,
    failed: 0,
    setupFailed: 0,
    discrepancies: 0,
    reverseDiscrepancies: 0,
    passedWithObservations: 0,
    byFailureKind: {},
    actions: 0,
  };
  for (const record of records) {
    const ev = record.evaluation;
    // SETUP_FAILED is quarantined: counted only here, never in passed/failed.
    if (ev.verdict === "PASS") totals.passed += 1;
    else if (ev.verdict === "FAIL") totals.failed += 1;
    else totals.setupFailed += 1;
    if (ev.discrepancy) totals.discrepancies += 1;
    if (ev.reverseDiscrepancy) totals.reverseDiscrepancies += 1;
    if (ev.passedWithObservations) totals.passedWithObservations += 1;
    if (ev.failureKind !== undefined) {
      totals.byFailureKind[ev.failureKind] = (totals.byFailureKind[ev.failureKind] ?? 0) + 1;
    }
  }

  // Check definitions verbatim — evaluator edits show up in PR diffs.
  const checksByScenario: Record<string, CheckConfig[]> = {};
  for (const [key, scenario] of Object.entries(config.scenarios)) {
    checksByScenario[key] = scenario.checks;
  }

  totals.actions = records.reduce((n, r) => n + r.steps.length, 0);
  const findings = args.findings ?? [];

  return {
    formatVersion: 1,
    appbacktestVersion: args.appbacktestVersion,
    app: { name: config.app.name, url: config.app.url },
    seed: args.seed,
    configHash: args.configHashValue,
    checksByScenario,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    runs: records.map(summarizeRun),
    totals,
    findings,
    findingCounts: countByCategory(findings),
  };
}

function summarizeRun(record: RunRecord): RunSummary {
  const ev = record.evaluation;
  const observationCounts: Partial<Record<ObservationKind, number>> = {};
  for (const obs of record.observations) {
    observationCounts[obs.kind] = (observationCounts[obs.kind] ?? 0) + 1;
  }
  const summary: RunSummary = {
    runId: record.runId,
    scenarioKey: record.scenarioKey,
    personaKey: record.personaKey,
    subSeed: record.subSeed,
    verdict: ev.verdict,
    ending: ev.ending,
    discrepancy: ev.discrepancy,
    reverseDiscrepancy: ev.reverseDiscrepancy,
    passedWithObservations: ev.passedWithObservations,
    steps: record.steps.length,
    durationMs: durationMs(record.startedAt, record.finishedAt),
    observationCounts,
    // Always POSIX and relative to outDir — records written on Windows must read on Linux CI.
    runDir: `runs/${record.runId}`,
  };
  if (ev.failureKind !== undefined) summary.failureKind = ev.failureKind;
  return summary;
}

function durationMs(startedAt: string, finishedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/**
 * Writes reports/<seed>-<yyyymmddHHMMSS>.json plus reports/latest.json (both
 * pretty-printed) under outDirAbs. Returns the absolute path of latest.json.
 */
export function writeReport(report: BacktestReport, outDirAbs: string): string {
  const reportsDir = path.join(outDirAbs, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const json = JSON.stringify(report, null, 2);
  const stampedPath = path.join(reportsDir, `${fsSafeSeed(report.seed)}-${timestamp()}.json`);
  fs.writeFileSync(stampedPath, json);
  const latestPath = path.join(reportsDir, "latest.json");
  fs.writeFileSync(latestPath, json);
  return latestPath;
}

/** Seeds are arbitrary strings; sanitize for filenames and cap at 40 chars. */
function fsSafeSeed(seed: string): string {
  const safe = seed.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.length > 40 ? safe.slice(0, 40) : safe;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
