/**
 * Preflight: fail in one actionable line each BEFORE spending time or tokens.
 */

import { existsSync } from "node:fs";
import { chromium } from "playwright";
import pc from "picocolors";
import type { AppBacktestConfig } from "../core/types";

export function preflight(config: AppBacktestConfig, opts: { needProvider: boolean }): void {
  const problems: string[] = [];

  if (opts.needProvider && config.provider.type === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    problems.push(
      "ANTHROPIC_API_KEY not set — add it to .env, or use provider.type: fixture for a zero-key run",
    );
  }
  if (
    opts.needProvider &&
    config.provider.type === "openai_compatible" &&
    config.provider.apiKeyEnv &&
    !process.env[config.provider.apiKeyEnv]
  ) {
    problems.push(
      `${config.provider.apiKeyEnv} not set — the openai_compatible provider needs it in .env (or drop apiKeyEnv for keyless endpoints)`,
    );
  }

  try {
    // executablePath() returns a path even when the browser was never
    // downloaded, so check that it actually exists on disk.
    const exe = chromium.executablePath();
    if (!exe || !existsSync(exe)) throw new Error("not installed");
  } catch {
    problems.push("Playwright Chromium missing — run: npx playwright install chromium");
  }

  if (problems.length > 0) {
    throw new Error(problems.map((p) => `preflight: ${p}`).join("\n"));
  }

  // Advisory, not fatal: state checks without a reset break same-seed reproducibility.
  const hasStateCheck = Object.values(config.scenarios).some((s) =>
    s.checks.some((c) => c.type === "http" && (c.count !== undefined || c.equals !== undefined)),
  );
  if (hasStateCheck && !config.app.resetHook) {
    console.log(
      pc.yellow(
        pc.bold(
          "⚠ http count/equals checks configured without app.resetHook — app state lives outside the seed, so " +
            "the same seed will NOT reproduce the same run and count checks will self-poison across runs. " +
            "Add app.resetHook (part of the determinism contract for stateful apps).",
        ),
      ),
    );
  }
}
