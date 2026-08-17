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

const KILL_GRACE_MS = 3000;

/**
 * Kill the app and everything it spawned, then WAIT for it to actually die.
 *
 * The waiting is not politeness — it is correctness. `ensureApp` treats "the
 * URL answers" as "the app is up", so a process that outlives stop() gets
 * silently reused by the next run, which then tests a stale build against the
 * wrong environment. That failure is invisible: every check that expects a bug
 * still passes, and only the checks that expect a FIX go red.
 *
 * With shell:true the direct child is /bin/sh, and the server is ITS child.
 * Signalling the shell alone orphans a process still holding the port, so on
 * POSIX the child is spawned as a process-group leader and the whole group is
 * signalled via the negative pid.
 */
async function killTree(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  const died = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
  });

  const signal = (sig: NodeJS.Signals): void => {
    try {
      if (process.platform === "win32" && proc.pid) {
        spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" });
      } else if (proc.pid) {
        // Negative pid = the whole process group (see detached below).
        try {
          process.kill(-proc.pid, sig);
        } catch {
          proc.kill(sig); // not a group leader after all — signal it directly
        }
      }
    } catch {
      // already gone
    }
  };

  signal("SIGTERM");
  const escalated = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), KILL_GRACE_MS),
  );
  if ((await Promise.race([died.then(() => "dead" as const), escalated])) === "timeout") {
    signal("SIGKILL");
    await died;
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

  const proc = spawn(app.command, {
    shell: true,
    cwd: configDir,
    stdio: ["ignore", "ignore", "pipe"],
    // POSIX: make the shell a process-group leader so killTree can signal the
    // whole group. Without this the server survives stop() and the next run
    // silently reuses it. Windows has no process groups here; taskkill /t
    // walks the tree instead.
    detached: process.platform !== "win32",
  });

  // Keep the last of stderr so a failed command explains itself instead of
  // timing out silently.
  let stderrTail = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-500);
  });

  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  proc.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  proc.on("error", (err) => {
    exited = { code: null, signal: null };
    stderrTail = `${stderrTail}\n${err.message}`.slice(-500);
  });

  const explain = () => {
    const detail = stderrTail.trim();
    return (
      `\n  command: ${app.command}\n  cwd: ${configDir}` +
      (detail ? `\n  stderr: ${detail.split("\n").slice(-4).join("\n          ")}` : "")
    );
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await reachable(app.url)) {
      return { started: true, stop: () => killTree(proc) };
    }
    // Fail fast: a command that already exited is never going to serve.
    if (exited) {
      throw new Error(
        `app.command exited (${exited.signal ?? `code ${exited.code ?? "?"}`}) before ${app.url} came up.${explain()}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await killTree(proc);
  throw new Error(
    `app at ${app.url} did not become reachable within ${READY_TIMEOUT_MS / 1000}s.${explain()}`,
  );
}
