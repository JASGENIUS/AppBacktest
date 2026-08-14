/**
 * App-under-test lifecycle: probe app.url; when unreachable and app.command
 * is configured, start it (cwd = the config file's directory), poll until
 * ready, and hand back a stop() that kills the process tree.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { AppConfig } from "../core/types";

const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 500;

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true; // any HTTP response counts — even a 500 means something is listening
  } catch {
    return false;
  }
}

function killTree(proc: ChildProcess): void {
  try {
    if (process.platform === "win32" && proc.pid) {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      proc.kill();
    }
  } catch {
    // already gone
  }
}

export async function ensureApp(
  app: AppConfig,
  configDir: string,
): Promise<{ started: boolean; stop(): Promise<void> }> {
  if (await reachable(app.url)) {
    return { started: false, stop: async () => {} };
  }

  if (!app.command) {
    throw new Error(
      `app not reachable at ${app.url} — is it running? (set app.command to have appbacktest start it)`,
    );
  }

  const proc = spawn(app.command, { shell: true, cwd: configDir, stdio: "ignore" });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await reachable(app.url)) {
      return {
        started: true,
        stop: async () => killTree(proc),
      };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  killTree(proc);
  throw new Error(
    `app at ${app.url} did not become reachable within ${READY_TIMEOUT_MS / 1000}s (command: ${app.command})`,
  );
}
