#!/usr/bin/env node
/**
 * appbacktest CLI — a thin, polished shell over the library.
 * Exit codes are CI contracts:
 *   run:        number of FAIL + SETUP_FAILED runs (capped 100)
 *   replay:     0 FIXED · 1 REPRODUCED · 2 DIVERGED · 3 INCONCLUSIVE
 *   regression: REPRODUCED + DIVERGED count (capped 100) — both fail the gate
 */

import "dotenv/config";
import { Command } from "commander";
import pc from "picocolors";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  appbacktestVersion,
  loadContext,
  rebuildReport,
  regressionAll,
  replayById,
  runBacktest,
} from "../index";
import { readRunRecord } from "../engine/recorder";
import { printReplayResult } from "../reporting/terminal";
import { initProject } from "./init";

const program = new Command();
program
  .name("appbacktest")
  .description("Backtesting for applications: AI probes, deterministic verification, replayable failures.")
  .version(appbacktestVersion);

function die(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`\n${message}`));
  if (process.env.ABT_DEBUG === "1" && err instanceof Error && err.stack) {
    console.error(pc.dim(err.stack));
  }
  process.exit(1);
}

program
  .command("init")
  .description("scaffold appbacktest.yaml, the .backtests/ tree, and the gitignore split")
  .action(() => {
    try {
      initProject(process.cwd());
    } catch (err) {
      die(err);
    }
  });

program
  .command("run")
  .description("run the backtest (streams every step; exit code = failed runs)")
  .option("--config <path>", "config file", "appbacktest.yaml")
  .option("--seed <seed>", "world seed (default: random, printed)")
  .option("--scenario <name>", "run a single scenario")
  .option("--headed", "show the browser window", false)
  .option("--watch", "watch the probe: visible browser, slowed down, cursor + HUD", false)
  .action(async (opts: { config: string; seed?: string; scenario?: string; headed: boolean; watch: boolean }) => {
    try {
      const seed = opts.seed ?? String(Math.floor(Math.random() * 900000) + 100000);
      console.log(`${pc.bold("AppBacktest")} ${pc.dim(`v${appbacktestVersion}`)} · seed ${pc.bold(seed)}`);
      if (opts.watch) console.log(pc.dim("watch mode: slowed down so you can follow along\n"));
      const report = await runBacktest({
        configPath: opts.config,
        seed,
        scenario: opts.scenario,
        headed: opts.headed,
        watch: opts.watch,
      });
      process.exit(Math.min(report.totals.failed + report.totals.setupFailed, 100));
    } catch (err) {
      die(err);
    }
  });

program
  .command("replay")
  .description("strict replay of a recorded run — deterministic, no LLM, ever")
  .argument("<runId>")
  .option("--config <path>", "config file", "appbacktest.yaml")
  .option("--headed", "show the browser window", false)
  .action(async (runId: string, opts: { config: string; headed: boolean }) => {
    try {
      const record = await replayById({ configPath: opts.config, runId, headed: opts.headed });
      printReplayResult(record);
      const code =
        record.replayOutcome === "FIXED"
          ? 0
          : record.replayOutcome === "REPRODUCED"
            ? 1
            : record.replayOutcome === "DIVERGED"
              ? 2
              : 3;
      process.exit(code);
    } catch (err) {
      die(err);
    }
  });

program
  .command("report")
  .description("regenerate the findings report and replay viewers from recorded runs (no app needed)")
  .option("--config <path>", "config file", "appbacktest.yaml")
  .option("--open", "print the path to open", false)
  .action((opts: { config: string }) => {
    try {
      const path = rebuildReport(opts.config);
      console.log(pc.green(`✓ report written`));
      console.log(`  ${path.replace(/\\/g, "/")}`);
      console.log(pc.dim("  each finding links to a replay you can scrub through"));
    } catch (err) {
      die(err);
    }
  });

program
  .command("promote")
  .description("copy a run (record + evidence) into .backtests/regressions/ — your committed failure library")
  .argument("<runId>")
  .option("--config <path>", "config file", "appbacktest.yaml")
  .action((runId: string, opts: { config: string }) => {
    try {
      const ctx = loadContext(opts.config);
      const src = join(ctx.outDirAbs, "runs", runId);
      if (!existsSync(join(src, "record.json"))) {
        throw new Error(`no run "${runId}" under ${ctx.outDirAbs}/runs — try: npx appbacktest list`);
      }
      const dst = join(ctx.outDirAbs, "regressions", runId);
      if (existsSync(dst)) throw new Error(`fixture "${runId}" already promoted`);
      cpSync(src, dst, { recursive: true });
      console.log(pc.green(`✓ promoted ${runId} → .backtests/regressions/${runId}/`));
      console.log(pc.dim("  commit .backtests/regressions/ to git — it is your team's failure library"));
    } catch (err) {
      die(err);
    }
  });

program
  .command("regression")
  .description("strict-replay every promoted fixture (REPRODUCED and DIVERGED both fail the gate)")
  .option("--config <path>", "config file", "appbacktest.yaml")
  .action(async (opts: { config: string }) => {
    try {
      const results = await regressionAll({ configPath: opts.config });
      if (results.length === 0) {
        console.log(pc.dim("no regression fixtures — promote a failed run first: npx appbacktest promote <runId>"));
        process.exit(0);
      }
      console.log(`\n${pc.bold("Previously discovered failures")}`);
      let gateFails = 0;
      for (const r of results) {
        const mark =
          r.outcome === "FIXED"
            ? pc.green("✓ FIXED     ")
            : r.outcome === "REPRODUCED"
              ? pc.red("✗ REPRODUCED")
              : r.outcome === "DIVERGED"
                ? pc.yellow("~ DIVERGED  ")
                : pc.magenta("? INCONCLUSIVE");
        console.log(`  ${mark} ${r.fixtureId}${r.divergence ? pc.dim(`  (${r.divergence.reason.slice(0, 90)})`) : ""}`);
        if (r.outcome === "REPRODUCED" || r.outcome === "DIVERGED") gateFails += 1;
      }
      if (gateFails > 0) {
        console.log(pc.red(`\ngate not satisfied: ${gateFails} fixture(s) still reproduce or diverged`));
      } else {
        console.log(pc.green("\nall fixtures fixed ✓"));
      }
      process.exit(Math.min(gateFails, 100));
    } catch (err) {
      die(err);
    }
  });

program
  .command("list")
  .description("list recorded runs and promoted fixtures")
  .option("--config <path>", "config file", "appbacktest.yaml")
  .action((opts: { config: string }) => {
    try {
      const ctx = loadContext(opts.config);
      for (const [label, dir] of [
        ["runs", join(ctx.outDirAbs, "runs")],
        ["regressions", join(ctx.outDirAbs, "regressions")],
      ] as const) {
        console.log(pc.bold(`\n${label}:`));
        if (!existsSync(dir)) {
          console.log(pc.dim("  (none)"));
          continue;
        }
        const ids = readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort();
        if (ids.length === 0) console.log(pc.dim("  (none)"));
        for (const id of ids) {
          try {
            const rec = readRunRecord(join(dir, id));
            const v = rec.evaluation.verdict;
            const mark =
              rec.replayOutcome ??
              (v === "PASS" ? pc.green("PASS") : v === "FAIL" ? pc.red("FAIL") : pc.magenta(v));
            console.log(
              `  ${id}  ${mark}${rec.evaluation.discrepancy ? pc.red("  DISCREPANCY") : ""}  ${pc.dim(rec.startedAt)}`,
            );
          } catch {
            console.log(`  ${id}  ${pc.dim("(unreadable record)")}`);
          }
        }
      }
    } catch (err) {
      die(err);
    }
  });

program.parseAsync(process.argv).catch(die);
