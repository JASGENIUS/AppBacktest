import { describe, expect, it } from "vitest";
import { runChecks } from "../src/evaluators";
import type { BrowserDriver } from "../src/core/types";

// `transient` checks are pure trace data — the driver is never touched.
const untouchableDriver = new Proxy({} as BrowserDriver, {
  get(_t, prop) {
    throw new Error(`transient checks must not touch the driver (accessed ${String(prop)})`);
  },
});

describe("transient check", () => {
  it("passes when any recorded toast contained the text (normalized)", async () => {
    const results = await runChecks(
      [{ type: "transient", contains: "upload RECEIVED" }],
      untouchableDriver,
      "http://x",
      { settleMs: 0, transients: ["file chosen: upload.png", "Upload  received"] },
    );
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.errored).toBe(false);
    expect(results[0]!.attempts).toBe(1);
  });

  it("fails without polling when no toast matched (trace data cannot change)", async () => {
    const results = await runChecks(
      [{ type: "transient", contains: "Upload received" }],
      untouchableDriver,
      "http://x",
      { settleMs: 0, pollMs: 1, transients: ["something else"] },
    );
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.errored).toBe(false);
    expect(results[0]!.attempts).toBe(1); // no re-polls for pure data
    expect(results[0]!.detail).toContain("Upload received");
  });
});
