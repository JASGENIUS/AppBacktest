/**
 * App lifecycle. The invariant under test is narrow but load-bearing:
 * stop() must leave NOTHING listening.
 *
 * ensureApp treats "the URL answers" as "the app is up". So a server that
 * survives stop() is not a leak you notice — it is silently adopted by the
 * next run, which then tests a stale build with the wrong environment. Every
 * check that expects a bug still passes; only checks that expect a FIX go red.
 * That is precisely how this shipped broken: with shell:true the direct child
 * is /bin/sh and the server is its child, so signalling the shell orphaned a
 * process still holding the port. Windows hid it (taskkill /t walks the tree).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureApp } from "../src/engine/appProcess";

const dir = mkdtempSync(join(tmpdir(), "appbacktest-appproc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PORT = 41977;
const URL_ = `http://127.0.0.1:${PORT}`;

// A server started through a shell, so the child process really is /bin/sh on
// POSIX — the exact shape that leaked.
writeFileSync(
  join(dir, "server.js"),
  `require("node:http").createServer((_q, s) => s.end("ok")).listen(${PORT});\n`,
);

async function listening(): Promise<boolean> {
  try {
    await fetch(URL_, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

describe("app lifecycle", () => {
  it("starts the app, and stop() leaves nothing listening on the port", async () => {
    expect(await listening(), `port ${PORT} was busy before the test started`).toBe(false);

    const app = await ensureApp(
      { name: "leak probe", url: URL_, command: "node server.js" },
      dir,
    );
    expect(app.started, "ensureApp did not start the app").toBe(true);
    expect(await listening()).toBe(true);

    await app.stop();

    // No polling loop here on purpose: stop() is specified to WAIT for the
    // process to die, so the port must already be free the instant it returns.
    expect(
      await listening(),
      "a process outlived stop() and is still holding the port — the next run would silently reuse it",
    ).toBe(false);
  }, 60_000);

  it("adopts an already-running app instead of starting a second one", async () => {
    const first = await ensureApp(
      { name: "leak probe", url: URL_, command: "node server.js" },
      dir,
    );
    const second = await ensureApp(
      { name: "leak probe", url: URL_, command: "node server.js" },
      dir,
    );
    expect(second.started, "started a duplicate server on a port already in use").toBe(false);

    await second.stop(); // adopted: must NOT kill something it did not start
    expect(await listening(), "stop() killed an app it did not start").toBe(true);

    await first.stop();
    expect(await listening()).toBe(false);
  }, 60_000);
});
