/**
 * Real-chromium smoke test for the driver. One browser launch, one tiny
 * static page server; each case exercises a trust-critical behavior:
 * perception fidelity, act-time identity re-verification, same-task
 * double-click, and filechooser interception on a hidden input.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../src/browser/driver";
import { Redactor } from "../src/core/redaction";
import { generateUploadPng } from "../src/browser/uploads";
import { sha256 } from "../src/core/hash";
import { Rng } from "../src/core/rng";
import { resolvePersona } from "../src/core/worldgen";
import type { BrowserDriver } from "../src/core/types";

const PAGE = `<!doctype html><html><head><title>Driver smoke</title></head><body>
  <main>
    <a href="/other">Load #38419 details</a>
    <label for="notes-in">Delivery notes</label><input id="notes-in" type="text">
    <label for="pw">Password</label><input id="pw" type="password">
    <label for="apikey">API Key</label><input id="apikey" type="text">
    <div id="shadow-host"></div>
    <input type="file" id="pod-file" style="display:none">
    <button id="choose-btn" onclick="document.getElementById('pod-file').click()">Choose photo</button>
    <span id="chosen"></span>
    <button id="counter-btn" onclick="this.dataset.clicks=(Number(this.dataset.clicks||0)+1); document.getElementById('clicks-out').textContent='clicks:'+this.dataset.clicks">Count me</button>
    <span id="clicks-out">clicks:0</span>
    <button id="rename-btn" onclick="document.getElementById('counter-btn').textContent='Totally different'">Rename it</button>
    <button id="toggle-btn" onclick="document.getElementById('extra').hidden = !document.getElementById('extra').hidden">Toggle section</button>
    <div id="extra" hidden><button id="extra-a">Extra A</button><button id="extra-b">Extra B</button></div>
    <button id="open-dlg" onclick="document.getElementById('dlg').hidden=false">Open dialog</button>
    <div id="dlg" role="dialog" aria-modal="true" aria-label="A dialog" hidden style="position:fixed;inset:0;background:#fff">
      <button id="close-dlg" onclick="document.getElementById('dlg').hidden=true">Close dialog</button>
    </div>
    <div style="height:3000px"></div>
    <button id="below-fold">Below the fold</button>
  </main>
  <script>
    document.getElementById('shadow-host').attachShadow({mode:'open'})
      .innerHTML = '<button id="shadow-btn">Shadow action</button>';
    document.getElementById('pod-file').addEventListener('change', (e) => {
      document.getElementById('chosen').textContent = e.target.files[0] ? e.target.files[0].name : '';
    });
  </script>
</body></html>`;

let server: Server;
let baseUrl: string;
let driver: BrowserDriver;
let workDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/other" ? "<html><body><main>other page</main></body></html>" : PAGE);
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  workDir = mkdtempSync(join(tmpdir(), "abt-browser-"));
  driver = createDriver({
    appUrl: baseUrl,
    headless: true,
    device: "desktop",
    actionTimeoutMs: 5000,
    workDir,
    uploadSizeKB: 40,
    uploadSeed: "smoke",
  });
  await driver.start();
}, 60_000);

afterAll(async () => {
  await driver?.close();
  server?.close();
  rmSync(workDir, { recursive: true, force: true });
});

const persona = resolvePersona({ doubleClickChance: 0 });
const rng = new Rng("smoke").fork("perturb");

/** The page mirrors the counter into visible text — read it like a user would. */
async function clicksShown(): Promise<number> {
  const text = await driver.visibleText();
  const m = /clicks:(\d+)/.exec(text);
  return m ? Number(m[1]) : -1;
}

describe("perception", () => {
  it("sees links, label[for] names, shadow-DOM buttons, below-fold elements — and never hidden file inputs", async () => {
    const p = await driver.perceive();
    const names = p.elements.map((e) => `${e.role}|${e.name}`);
    expect(names).toContain("link|Load #38419 details");
    expect(names).toContain("textbox|Delivery notes"); // label[for] accessible name
    expect(names).toContain("button|Shadow action"); // open shadow root pierced
    expect(names).toContain("button|Below the fold"); // visibility ≠ viewport
    expect(p.elements.some((e) => e.role === "file")).toBe(false); // hidden input excluded
    expect(p.title).toBe("Driver smoke");
  });
});

describe("act", () => {
  it("clicks and reports the verified resolved target", async () => {
    const p = await driver.perceive();
    const btn = p.elements.find((e) => e.name === "Count me")!;
    const outcome = await driver.act({ kind: "click", ref: btn.ref }, { persona, rng });
    expect(outcome.ok).toBe(true);
    expect(outcome.resolvedTarget).toMatchObject({ role: "button", name: "Count me" });
    expect(outcome.perturbations).toHaveLength(0);
    expect(await clicksShown()).toBe(1);
  });

  it("forced double_click dispatches both clicks in the same task", async () => {
    const p = await driver.perceive();
    const btn = p.elements.find((e) => e.name === "Count me")!;
    const outcome = await driver.act(
      { kind: "click", ref: btn.ref },
      { persona, rng, forcedPerturbations: [{ kind: "double_click" }] },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.perturbations).toEqual([{ kind: "double_click" }]);
    expect(await clicksShown()).toBe(3); // 1 from the previous test + 2 now
  });

  it("refuses to dispatch when the target's identity changed after perception (stale_target)", async () => {
    const p = await driver.perceive();
    const counter = p.elements.find((e) => e.name === "Count me")!;
    const rename = p.elements.find((e) => e.name === "Rename it")!;
    // A real user action renames the counter button between perceive and act.
    await driver.act({ kind: "click", ref: rename.ref }, { persona, rng });
    const outcome = await driver.act({ kind: "click", ref: counter.ref }, { persona, rng });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorKind).toBe("stale_target");
    expect(await clicksShown()).toBe(3); // the mismatched node was NOT clicked
  });

  it("recovers after a fresh perception of the changed page", async () => {
    const p = await driver.perceive();
    const renamed = p.elements.find((e) => e.name === "Totally different")!;
    const outcome = await driver.act({ kind: "click", ref: renamed.ref }, { persona, rng });
    expect(outcome.ok).toBe(true);
    expect(await clicksShown()).toBe(4); // same node, new identity, clean dispatch
  });

  it("upload through the styled proxy satisfies the hidden input via filechooser", async () => {
    await driver.act({ kind: "navigate", url: "/" }, { persona, rng });
    const p = await driver.perceive();
    const choose = p.elements.find((e) => e.name === "Choose photo")!;
    const outcome = await driver.act({ kind: "upload", ref: choose.ref }, { persona, rng });
    expect(outcome.ok).toBe(true);
    const text = await driver.visibleText();
    expect(text).toContain("upload.png"); // the page's change handler saw the file
  });
});

describe("perception hygiene", () => {
  it("does not report a hidden dialog as an open modal", async () => {
    const p = await driver.perceive();
    expect(p.modalOpen, "a [hidden] dialog must not count as open").toBeUndefined();
  });

  it("reports a genuinely visible modal", async () => {
    const p = await driver.perceive();
    const open = p.elements.find((e) => e.name === "Open dialog")!;
    await driver.act({ kind: "click", ref: open.ref }, { persona, rng });
    const after = await driver.perceive();
    expect(after.modalOpen).toBeTruthy();
    // ...and closing it clears the flag again
    const close = after.elements.find((e) => e.name === "Close dialog")!;
    await driver.act({ kind: "click", ref: close.ref }, { persona, rng });
    expect((await driver.perceive()).modalOpen).toBeUndefined();
  });

  it("clears stale refs so no two elements ever share one", async () => {
    // Toggling swaps which controls are present, so ref indices shift.
    const p1 = await driver.perceive();
    const toggle = p1.elements.find((e) => e.name === "Toggle section")!;
    await driver.act({ kind: "click", ref: toggle.ref }, { persona, rng });
    const p2 = await driver.perceive();
    const refs = p2.elements.map((e) => e.ref);
    expect(new Set(refs).size, "duplicate refs in one perception").toBe(refs.length);

    // Behavioural proof: newly revealed controls must dispatch to themselves.
    // With stale tags left behind, these refs collide with earlier elements and
    // the identity check fails with stale_target instead.
    const extraA = p2.elements.find((e) => e.name === "Extra A")!;
    const outcome = await driver.act({ kind: "click", ref: extraA.ref }, { persona, rng });
    expect(outcome.ok, `expected a clean dispatch, got ${outcome.errorKind}: ${outcome.error}`).toBe(true);
    expect(outcome.resolvedTarget?.name).toBe("Extra A");
  });
});

/**
 * Reach into the live page. Deliberately a cast rather than a method on
 * BrowserDriver — the overlay is an implementation detail and does not belong
 * on the interface the engine programs against.
 */
function inPage<T>(expression: string): Promise<T> {
  const page = (driver as unknown as { page: { evaluate: (e: string) => Promise<T> } }).page;
  return page.evaluate(expression);
}

describe("drawn cursor", () => {
  /**
   * The cursor is evidence, not decoration: without it a replay screenshot
   * cannot show WHICH control the simulated user hit. It ships in headless
   * runs too, which means it must be provably invisible to the agent — an
   * overlay the walker could perceive, or that could swallow a click, would
   * corrupt every run.
   */
  it("exists in a headless run and sits on the element just acted on", async () => {
    const p = await driver.perceive();
    const btn = p.elements.find((e) => e.name === "Count me")!;
    await driver.act({ kind: "click", ref: btn.ref }, { persona, rng });

    const placed = await inPage<{ present: boolean; onTarget?: boolean }>(`(() => {
      const c = document.getElementById("__abt_cursor");
      if (!c) return { present: false };
      const target = document.getElementById("counter-btn").getBoundingClientRect();
      const cx = parseFloat(c.style.left) + 10, cy = parseFloat(c.style.top) + 10;
      return {
        present: true,
        onTarget:
          cx >= target.left && cx <= target.right && cy >= target.top && cy <= target.bottom,
      };
    })()`);

    expect(placed.present, "no cursor drawn in a headless run").toBe(true);
    expect(placed.onTarget, "cursor was not placed on the clicked control").toBe(true);
  });

  it("is never perceived, and never blocks the click underneath it", async () => {
    const p = await driver.perceive();
    const overlayRefs = p.elements.filter((e) => /__abt_|appbacktest/i.test(e.name));
    expect(overlayRefs, "AppBacktest's own overlay leaked into perception").toEqual([]);

    // The cursor is parked on this button from the previous case; clicking it
    // again must still reach the app (pointer-events:none doing its job).
    const btn = p.elements.find((e) => e.name === "Count me")!;
    const outcome = await driver.act({ kind: "click", ref: btn.ref }, { persona, rng });
    expect(outcome.ok, `overlay swallowed the click: ${outcome.error}`).toBe(true);
  });

  it("draws no HUD unless watch mode asked for one", async () => {
    const hud = await inPage<boolean>(`document.getElementById("__abt_hud") === null`);
    expect(hud, "the watch HUD appeared in a headless run and would cover the app").toBe(true);
  });
});

describe("redaction at capture", () => {
  /**
   * The privacy guarantee that matters: a secret typed into the real page
   * must never appear in the recorded evidence. The value IS typed (the app
   * behaves normally); only what gets written down is masked.
   */
  let secretDriver: BrowserDriver;
  let secretWorkDir: string;

  beforeAll(async () => {
    secretWorkDir = mkdtempSync(join(tmpdir(), "abt-redact-"));
    secretDriver = createDriver({
      appUrl: baseUrl,
      headless: true,
      device: "desktop",
      actionTimeoutMs: 5000,
      workDir: secretWorkDir,
      uploadSizeKB: 20,
      uploadSeed: "redact",
      redactor: new Redactor({
        enabled: true,
        fieldPatterns: ["password", "api[\\s_-]?key"],
        valuePatterns: ["\\bsk-[A-Za-z0-9]{6,}"],
        mask: "[redacted]",
      }),
    });
    await secretDriver.start();
  }, 60_000);

  afterAll(async () => {
    await secretDriver?.close();
    rmSync(secretWorkDir, { recursive: true, force: true });
  });

  it("marks password inputs sensitive and never reads their value back", async () => {
    const p = await secretDriver.perceive();
    const pw = p.elements.find((e) => e.name === "Password");
    expect(pw, "password field not perceived").toBeTruthy();
    expect(pw!.role).toBe("password");
    expect(pw!.sensitive).toBe(true);
  });

  it("masks a value typed into a password field, while still typing it", async () => {
    const p = await secretDriver.perceive();
    const pw = p.elements.find((e) => e.name === "Password")!;
    const outcome = await secretDriver.act(
      { kind: "type", ref: pw.ref, text: "hunter2-real-secret" },
      { persona, rng },
    );
    expect(outcome.ok).toBe(true);
    // What the engine will record:
    expect(outcome.redactedText).toBe("[redacted]");
    expect(JSON.stringify(outcome)).not.toContain("hunter2");
    // ...and the app really did receive the value:
    const after = await secretDriver.perceive();
    const pwAfter = after.elements.find((e) => e.name === "Password")!;
    expect(pwAfter.value).toBeUndefined(); // never read back out of the page
  });

  it("masks a secret-looking field by name, not just by input type", async () => {
    const p = await secretDriver.perceive();
    const key = p.elements.find((e) => e.name === "API Key")!;
    const outcome = await secretDriver.act(
      { kind: "type", ref: key.ref, text: "sk-abcdef123456" },
      { persona, rng },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.redactedText).toBe("[redacted]");
  });

  it("leaves ordinary fields untouched", async () => {
    const p = await secretDriver.perceive();
    const notes = p.elements.find((e) => e.name === "Delivery notes")!;
    const outcome = await secretDriver.act(
      { kind: "type", ref: notes.ref, text: "left at the dock" },
      { persona, rng },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.redactedText).toBeUndefined();
  });
});

describe("uploads", () => {
  it("deterministic bytes: same seed+size ⇒ identical sha; valid PNG signature; ~target size", () => {
    const a = generateUploadPng("seed-a", 64);
    const b = generateUploadPng("seed-a", 64);
    const c = generateUploadPng("seed-b", 64);
    expect(sha256(a.toString("base64"))).toBe(sha256(b.toString("base64")));
    expect(sha256(a.toString("base64"))).not.toBe(sha256(c.toString("base64")));
    expect([...a.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(Math.abs(a.length - 64 * 1024)).toBeLessThan(64 * 1024 * 0.2);
  });
});
