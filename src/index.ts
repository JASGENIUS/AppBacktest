/**
 * AppBacktest library API. The CLI is a thin shell over this — CI pipelines,
 * scripts, and coding agents can drive everything programmatically.
 */

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
import { preflight } from "./cli/preflight";
import type { BacktestReport, EngineEvents, RunRecord } from "./core/types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const appbacktestVersion: string = (require("../package.json") as { version: string }).version;

export interface RunBacktestArgs {
  configPath: string;
  seed?: string;
  scenario?: string;
  headed?: boolean;
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
  if (args.headed) config.browser.headless = false;

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

  const report = buildReport({
    records,
    config,
    seed,
    configHashValue: ctx.configHashValue,
    appbacktestVersion,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  writeReport(report, outDirAbs);
  if (print) printReport(report, outDirAbs);
  return report;
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
