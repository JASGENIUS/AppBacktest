/**
 * `appbacktest init` — scaffold config + artifact tree + the exact gitignore
 * split (.backtests/runs ignored; .backtests/regressions committed — that
 * split is what makes the team failure-library real).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";

const CONFIG_TEMPLATE = `# AppBacktest configuration — https://github.com/jasroopsangha/appbacktest
# AI-simulated users pursue goals through your real UI; deterministic checks
# verify what actually happened; failures become replayable regressions.

app:
  name: My App
  url: http://localhost:3000
  # Optional: appbacktest starts your app, polls url until ready, kills it on exit.
  # command: npm run dev
  # STRONGLY recommended for stateful apps — part of the determinism contract.
  # An endpoint that restores pristine state before each run:
  # resetHook: { method: POST, url: /api/test/reset }

provider:
  type: anthropic          # needs ANTHROPIC_API_KEY in .env
  model: claude-opus-5
  effort: low
  # Any OpenAI-compatible endpoint (NVIDIA NIM free tier, OpenAI, Ollama):
  # type: openai_compatible
  # baseUrl: https://integrate.api.nvidia.com/v1
  # model: nvidia/nemotron-3-super-120b-a12b
  # apiKeyEnv: NVIDIA_API_KEY        # omit for keyless endpoints
  # Zero-key deterministic alternative (decisions from a JSON file):
  # type: fixture
  # path: ./fixtures/my-scenario.json

personas:                  # reusable trait bundles (no goals here)
  casual_user:
    device: desktop
    patience: normal       # low=12 / normal=20 / high=30 max steps
    doubleClickChance: 0.2 # executor-level, seeded — a real human mistake
    uploadSizeKB: 400
    traits: ["not very technical", "in a hurry"]

scenarios:                 # a goal and its proof, side by side
  example_flow:
    persona: casual_user
    goal: >
      Sign in and change your display name to "Alex", then make sure it saved.
    checks:
      - { type: text, contains: "Saved" }
      # For toasts / auto-dismissing messages use transient, not text —
      # it asserts "the user was shown X" against the recorded trace:
      # - { type: transient, contains: "Profile saved" }
      # State assertions are the workhorse — the agent's opinion is never trusted:
      # - { type: http, url: /api/me, path: profile.displayName, equals: "Alex" }

runs: 1
browser: { headless: true, actionTimeoutMs: 8000 }

# Evidence (records, screenshots, replays) is written under outDir, which is
# resolved relative to THIS file. Testing a throwaway copy of an app? Point
# outDir somewhere durable or the replays are deleted along with the copy.
# outDir: /absolute/path/to/keep/evidence
`;

const GITIGNORE_STANZA = `
# AppBacktest artifacts (regressions/ is meant to be committed — it is your failure library)
.backtests/runs/
.backtests/reports/
`;

export function initProject(cwd: string): void {
  const configPath = join(cwd, "appbacktest.yaml");
  if (existsSync(configPath)) {
    throw new Error("appbacktest.yaml already exists — refusing to overwrite it");
  }
  writeFileSync(configPath, CONFIG_TEMPLATE);

  mkdirSync(join(cwd, ".backtests", "runs"), { recursive: true });
  mkdirSync(join(cwd, ".backtests", "regressions"), { recursive: true });
  mkdirSync(join(cwd, ".backtests", "reports"), { recursive: true });
  writeFileSync(join(cwd, ".backtests", "regressions", ".gitkeep"), "");

  const gitignorePath = join(cwd, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (!existing.includes(".backtests/runs/")) {
    appendFileSync(gitignorePath, GITIGNORE_STANZA);
  }

  const envExample = join(cwd, ".env.example");
  if (!existsSync(envExample)) {
    writeFileSync(envExample, "# Only needed for provider.type: anthropic\nANTHROPIC_API_KEY=\n");
  }

  console.log(pc.green("✓ appbacktest.yaml created"));
  console.log(pc.green("✓ .backtests/ tree created (runs/ + reports/ gitignored, regressions/ committed)"));
  console.log(pc.green("✓ .env.example created"));
  console.log(`\nNext steps:
  1. Edit ${pc.bold("appbacktest.yaml")} — point app.url at your app, write a goal + checks
  2. Set ${pc.bold("ANTHROPIC_API_KEY")} in .env (or use the fixture provider)
  3. ${pc.bold("npx appbacktest run")}   (add --headed to watch the browser)`);
}
