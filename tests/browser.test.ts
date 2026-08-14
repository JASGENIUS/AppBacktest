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
import { generateUploadPng } from "../src/browser/uploads";
import { sha256 } from "../src/core/hash";
import { Rng } from "../src/core/rng";
import { resolvePersona } from "../src/core/worldgen";
import type { BrowserDriver } from "../src/core/types";

const PAGE = `<!doctype html><html><head><title>Driver smoke</title></head><body>
  <main>
    <a href="/other">Load #38419 details</a>
    <label for="notes-in">Delivery notes</label><input id="notes-in" type="text">
    <div id="shadow-host"></div>
    <input type="file" id="pod-file" style="display:none">
    <button id="choose-btn" onclick="document.getElementById('pod-file').click()">Choose photo</button>
    <span id="chosen"></span>
    <button id="counter-btn" onclick="this.dataset.clicks=(Number(this.dataset.clicks||0)+1); document.getElementById('clicks-out').textContent='clicks:'+this.dataset.clicks">Count me</button>
    <span id="clicks-out">clicks:0</span>
    <button id="rename-btn" onclick="document.getElementById('counter-btn').textContent='Totally different'">Rename it</button>
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
