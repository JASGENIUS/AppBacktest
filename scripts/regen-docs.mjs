/**
 * Regenerate the two watch-mode screenshots in docs/ so they match the shipped
 * HUD text. Uses the REAL overlay source from src, never a mock-up, so the
 * images stay honest: if the overlay changes, re-running this shows it.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").split("\\").join("/");
const PORT = 4319;
const URL_ = `http://127.0.0.1:${PORT}`;

// Pull the overlay source straight out of the TypeScript, so it cannot drift.
const perception = readFileSync(`${ROOT}/src/browser/perception.ts`, "utf8");
const grab = (name) => {
  const start = perception.indexOf(`export const ${name} = \``);
  if (start === -1) throw new Error(`${name} not found`);
  const from = perception.indexOf("`", start) + 1;
  const to = perception.indexOf("`;", from);
  // Reading the raw file leaves one extra level of escaping that the TypeScript
  // compiler would normally collapse (`\\u00b7` in source is `·` in the
  // string value). Without this the HUD renders a literal escape sequence.
  return perception.slice(from, to).split("\\\\").join("\\");
};
const OVERLAY = grab("WATCH_OVERLAY_SOURCE");
const UPDATE = grab("WATCH_UPDATE_SOURCE");

const server = spawn(process.execPath, ["server.js"], {
  cwd: `${ROOT}/examples/expense-app`,
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
  detached: process.platform !== "win32",
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  try {
    await fetch(URL_, { signal: AbortSignal.timeout(800) });
    break;
  } catch {
    await wait(300);
  }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

const GOAL =
  "Submit a new expense for a client lunch that cost 48.20, categorised as Meals, " +
  "with the note \u201cClient lunch with Acme\u201d attached. Make sure the expense is actually saved before you finish.";
await ctx.addInitScript(`window.__abt_hud_goal = ${JSON.stringify(GOAL)};`);
await ctx.addInitScript(OVERLAY);

const page = await ctx.newPage();

async function shot(file, { fill, target, act }) {
  await page.goto(`${URL_}/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  if (fill) await fill();
  await page.evaluate(
    `${UPDATE}(${JSON.stringify(target)}, ${JSON.stringify(act)}, false, "step 4")`,
  );
  // The HUD is present, so the cursor glides with a 420ms transition. Waiting
  // less than that photographs the dot mid-flight, somewhere it never landed.
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${ROOT}/docs/${file}`, fullPage: false });
  console.log(`wrote docs/${file}`);
}

await shot("watch-mode.png", {
  fill: async () => {
    // Open the note dialog and fill it: the cursor then sits on the button it
    // is actually about to press, which also shows how a modal is handled.
    await page.click("#note-btn").catch(() => {});
    await page.waitForTimeout(300);
    await page.fill("#note-text", "Client lunch with Acme").catch(() => {});
  },
  target: "#note-save",
  act: "clicking \u201cSave note\u201d",
});

await shot("watch-verify.png", {
  fill: async () => {
    await page.fill("#description", "Client lunch").catch(() => {});
    await page.fill("#amount", "48.20").catch(() => {});
    await page.selectOption("#category", { label: "Meals" }).catch(() => {});
    await page.waitForTimeout(200);
  },
  target: "#category",
  act: "thinking about the next step\u2026",
});

await browser.close();
try {
  if (server.pid) process.kill(process.platform === "win32" ? server.pid : -server.pid);
} catch {}
console.log("done");
