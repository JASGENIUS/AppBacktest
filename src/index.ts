/**
 * AppBacktest library API. The CLI is a thin shell over this — CI pipelines,
 * scripts, and coding agents can drive everything programmatically.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "./core/config";
import { configHash } from "./core/hash";
import { generateWorld } from "./core/worldgen";
import { createProvider } from "./providers";
import { createDriver } from "./browser/driver";
import { ensureApp } from "./engine/appProcess";
import { executeRun } from "./engine/runner";
import { replayRun } from "./engine/replayer";
import { runRegression } from "./engine/regression";
import { readRunRecord } from "./engine/recorder";
import { buildReport, writeReport } from "./reporting/json";
import { printReport, printRunEnd, printRunStart, printStepLine } from "./reporting/terminal";
import { printFindings, writeFindingsHtml } from "./reporting/findingsReport";
import { writeReplayHtml } from "./reporting/replayHtml";
import { buildFindings, sortFindings } from "./findings";
import { correlateSource } from "./findings/source";
import { buildUxFindings } from "./ux";
import { preflight } from "./cli/preflight";
import type {
  AppBacktestConfig,
  BacktestReport,
  EngineEvents,
  RunRecord,
  SourceConfig,
} from "./core/types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const appbacktestVersion: string = (require("../package.json") as { version: string }).version;

export interface RunBacktestArgs {
  configPath: string;
  seed?: string;
  scenario?: string;
  headed?: boolean;
  /** Visible browser, slowed down, with a drawn cursor + HUD. Implies headed. */
  watch?: boolean;
  /** Print per-step progress to the terminal (default true). */
  print?: boolean;
  events?: EngineEvents;
}

export interface BacktestContext {
  config: ReturnType<typeof loadConfig>;
  configDir: string;
  outDirAbs: string;
  configHashValue: string;
}

export function loadContext(configPath: string): BacktestContext {
  const abs = resolve(configPath);
  const config = loadConfig(abs);
  const configDir = dirname(abs);
  const outDirAbs = isAbsolute(config.outDir) ? config.outDir : join(configDir, config.outDir);
  return { config, configDir, outDirAbs, configHashValue: configHash(config) };
}

export async function runBacktest(args: RunBacktestArgs): Promise<BacktestReport> {
  const ctx = loadContext(args.configPath);
  const { config, configDir, outDirAbs } = ctx;
  if (args.headed || args.watch) config.browser.headless = false;
  if (args.watch) config.browser.watch = true;

  const seed = args.seed ?? String(Math.floor(Math.random() * 900000) + 100000);
  const world = generateWorld(config, seed);
  let plans = world.runs;
  if (args.scenario) {
    plans = plans.filter((p) => p.scenarioKey === args.scenario);
    if (plans.length === 0) {
      throw new Error(
        `unknown scenario "${args.scenario}" — known: ${Object.keys(config.scenarios).join(", ")}`,
      );
    }
  }

  preflight(config, { needProvider: true });
  const app = await ensureApp(config.app, configDir);
  const print = args.print ?? true;

  const events: EngineEvents = {
    onRunStart: (plan) => {
      if (print) printRunStart(plan);
      args.events?.onRunStart?.(plan);
    },
    onStep: (step) => {
      if (print) printStepLine(step);
      args.events?.onStep?.(step);
    },
    onRunEnd: (record) => {
      if (print) printRunEnd(record);
      args.events?.onRunEnd?.(record);
    },
  };

  const startedAt = new Date().toISOString();
  const records: RunRecord[] = [];
  try {
    for (const plan of plans) {
      // A fresh provider per run: fixture decision lists are per-run state,
      // and every run must start from decision 0.
      const provider = createProvider(config.provider);
      records.push(
        await executeRun(plan, {
          provider,
          // Concurrent runs need an independent provider per simulated person.
          makeProvider: () => createProvider(config.provider),
          makeDriver: createDriver,
          config,
          outDirAbs,
          seed,
          configHashValue: ctx.configHashValue,
          appbacktestVersion,
          events,
        }),
      );
    }
  } finally {
    await app.stop();
  }

  // --- Interpretation: evidence → findings → replay artifacts ---
  const runDirOf = (r: RunRecord) => `runs/${r.runId}`;
  const bugs = buildFindings({ records, replay: config.replay, runDirOf });
  const ux = buildUxFindings({ records, ux: config.ux, replay: config.replay, runDirOf });
  const findings = correlateSource(sortFindings([...bugs, ...ux]), resolveSourceConfig(config, configDir));

  // A replay viewer per run, written beside that run's screenshots.
  for (const record of records) {
    try {
      writeReplayHtml(record, join(outDirAbs, "runs", record.runId), findings);
    } catch {
      // A viewer is a convenience; never fail a session over it.
    }
  }

  const report = buildReport({
    records,
    config,
    seed,
    configHashValue: ctx.configHashValue,
    appbacktestVersion,
    startedAt,
    finishedAt: new Date().toISOString(),
    findings,
  });
  writeReport(report, outDirAbs);
  const htmlPath = writeFindingsHtml(report, findings, outDirAbs);
  if (print) {
    printReport(report, outDirAbs);
    printFindings(findings, outDirAbs);
    console.log(`\n  full report: ${htmlPath.replace(/\\/g, "/")}`);
  }
  return report;
}

/**
 * Rebuild findings, replay viewers and the HTML report from runs already on
 * disk. Pure post-processing — no browser, no app, no LLM — so you can
 * re-analyse a session (or a colleague's committed artifacts) at any time.
 */
export function rebuildReport(configPath: string): string {
  const ctx = loadContext(configPath);
  const { config, configDir, outDirAbs } = ctx;
  const runsDir = join(outDirAbs, "runs");
  if (!existsSync(runsDir)) throw new Error(`no runs recorded under ${runsDir}`);

  const records: RunRecord[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const record = readRunRecord(join(runsDir, entry.name));
      // Replays of earlier runs are derivative; report on originals only.
      if (!record.replayOf) records.push(record);
    } catch {
      // unreadable or foreign directory — skip
    }
  }
  if (records.length === 0) throw new Error(`no readable run records under ${runsDir}`);
  records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const runDirOf = (r: RunRecord) => `runs/${r.runId}`;
  const bugs = buildFindings({ records, replay: config.replay, runDirOf });
  const ux = buildUxFindings({ records, ux: config.ux, replay: config.replay, runDirOf });
  const findings = correlateSource(sortFindings([...bugs, ...ux]), resolveSourceConfig(config, configDir));

  for (const record of records) {
    try {
      writeReplayHtml(record, join(outDirAbs, "runs", record.runId), findings);
    } catch {
      // viewer is a convenience
    }
  }

  const report = buildReport({
    records,
    config,
    seed: records[records.length - 1]!.seed,
    configHashValue: ctx.configHashValue,
    appbacktestVersion,
    startedAt: records[0]!.startedAt,
    finishedAt: records[records.length - 1]!.finishedAt,
    findings,
  });
  writeReport(report, outDirAbs);
  printFindings(findings, outDirAbs);
  return writeFindingsHtml(report, findings, outDirAbs);
}

/** Source correlation is read-only and opt-in; resolve its root against the config dir. */
function resolveSourceConfig(config: AppBacktestConfig, configDir: string): SourceConfig {
  const src = config.source;
  if (!src.enabled || !src.root) return src;
  return { ...src, root: isAbsolute(src.root) ? src.root : resolve(configDir, src.root) };
}

export async function replayById(args: {
  configPath: string;
  runId: string;
  headed?: boolean;
  print?: boolean;
}): Promise<RunRecord> {
  const ctx = loadContext(args.configPath);
  if (args.headed) ctx.config.browser.headless = false;
  const { existsSync } = await import("node:fs");

  const candidates = [
    join(ctx.outDirAbs, "runs", args.runId),
    join(ctx.outDirAbs, "regressions", args.runId),
  ];
  const recordDir = candidates.find((d) => existsSync(join(d, "record.json")));
  if (!recordDir) {
    throw new Error(
      `no run record for "${args.runId}" under ${ctx.outDirAbs}/runs or /regressions — try: npx appbacktest list`,
    );
  }
  const record = readRunRecord(recordDir);

  preflight(ctx.config, { needProvider: false });
  const app = await ensureApp(ctx.config.app, ctx.configDir);
  try {
    return await replayRun(record, {
      makeDriver: createDriver,
      config: ctx.config,
      outDirAbs: ctx.outDirAbs,
      appbacktestVersion,
    });
  } finally {
    await app.stop();
  }
}

export async function regressionAll(args: {
  configPath: string;
  print?: boolean;
}): Promise<Awaited<ReturnType<typeof runRegression>>> {
  const ctx = loadContext(args.configPath);
  preflight(ctx.config, { needProvider: false });
  const app = await ensureApp(ctx.config.app, ctx.configDir);
  try {
    return await runRegression({
      makeDriver: createDriver,
      config: ctx.config,
      outDirAbs: ctx.outDirAbs,
      appbacktestVersion,
    });
  } finally {
    await app.stop();
  }
}

// --- Re-exports: the stable library surface ---
export { buildFindings, buildTimeline, buildClip, formatOffset, sortFindings, countByCategory } from "./findings";
export { correlateSource } from "./findings/source";
export { buildUxFindings } from "./ux";
export { Redactor } from "./core/redaction";
export { renderReplayHtml, writeReplayHtml } from "./reporting/replayHtml";
export { renderFindingsHtml, writeFindingsHtml, printFindings } from "./reporting/findingsReport";
export { loadConfig, resolveUrl } from "./core/config";
export { generateWorld, resolvePersona } from "./core/worldgen";
export { Rng } from "./core/rng";
export { configHash, sha256, stableStringify } from "./core/hash";
export { createProvider } from "./providers";
export { createDriver } from "./browser/driver";
export { executeRun } from "./engine/runner";
export { replayRun, NEVER_RNG } from "./engine/replayer";
export { runRegression } from "./engine/regression";
export { readRunRecord, writeRunRecord } from "./engine/recorder";
export { ensureApp } from "./engine/appProcess";
export { buildReport, writeReport } from "./reporting/json";
export * from "./core/types";
