# AppBacktest

**Backtesting, but for software applications.**

AI-simulated users pursue goals through your real UI. Deterministic code
verifies what actually happened. Every discovered failure becomes a
replayable regression.

```
Actor: driver          Goal: Upload proof of delivery for load #38419
```

The simulated user figures out the flow itself — dashboard → find the load →
choose a photo → upload → read the confirmation. It double-clicks when it's
impatient. And when it proudly reports success, **AppBacktest doesn't believe
it**:

```
▶ pod_upload [driver] sub-seed 555001:pod_upload:1
  #0 click 'Load #38419 — Chicago, IL → Detroit, MI (in transit)' → ok (/loads/38419)
  #1 upload via 'Choose photo' → ok (/loads/38419)
    💬 file chosen: upload.png
  #2 type "Delivered to dock 4" into 'Delivery notes' → ok (/loads/38419)
  #3 click 'Upload POD' → ok (/loads/38419)
    ⚡ double-click
  #4 wait 1500ms → ok (/loads/38419)
    💬 Upload received
  #5 done (success): Uploaded the POD photo and saw the confirmation message.
  FAIL (assertion) · ended: done · 6 steps
  ⚠ DISCREPANCY: the agent believed it succeeded — the application state says otherwise.
    agent: "Uploaded the POD photo and saw the confirmation message."
    check failed {"type":"http","url":"/api/loads/38419/pods","count":1}
      expected count 1, got 2
    replay:   npx appbacktest replay pod_upload-3fe9d0eb-20260814003743
    keep it:  npx appbacktest promote pod_upload-3fe9d0eb-20260814003743
```

One user action created two POD records. The app said "Upload received." The
simulated user believed it. The state check caught it. That gap — between
what the UI claims, what the user believes, and what actually happened — is
where the interesting bugs live, and it's exactly what scripted E2E tests
cannot see.

## The idea

| | Scripted E2E | AppBacktest |
|---|---|---|
| Asks | "does the path I predicted still work?" | "does the app survive a plausible human?" |
| Steps | you write selectors and clicks | an AI decides what a person would do |
| Verdict | assertions you predicted | independent state verification + belief/reality **discrepancy** detection |
| Failures | a red test | a **replayable fixture** with full evidence |

**The trust boundary is the whole product:** the LLM generates *behavior*;
deterministic code issues the *verdict*. The agent's decisions are
schema-constrained to a closed action vocabulary; its opinion of success is
recorded but never trusted; checks run against your app's real state.

AppBacktest complements unit / integration / scripted E2E testing — its
specialty is simulation, discovery, and turning what it discovers into
regressions.

## Quickstart (zero API keys)

```bash
git clone https://github.com/jasroopsangha/appbacktest
cd appbacktest && npm install
npx playwright install chromium   # ~130MB, one time
npm run demo                      # ← the full loop, deterministic, no keys
```

`npm run demo` backtests the bundled PODHaul app (which ships with a planted
double-submit bug) using the **fixture provider** — recorded decisions, so it
runs identically on every machine. Three simulated drivers upload a POD;
seeded persona perturbations decide which of them double-clicks. Then close
the loop:

```bash
# 1. The run above discovered a failure. Reproduce it — no LLM, deterministic:
npx appbacktest replay <runId> --config examples/pod-app/appbacktest.yaml
#    ✗ REPRODUCED

# 2. Keep it forever:
npx appbacktest promote <runId> --config examples/pod-app/appbacktest.yaml

# 3. Gate is red while the bug lives:
npm run demo:regression            # ✗ REPRODUCED → exit code 1

# 4. "Fix" the app (FIXED=1 repairs the demo bug) and the gate goes green:
FIXED=1 npm run demo:regression    # ✓ FIXED → exit code 0
```

That's the loop: **run → discover → replay → promote → fix → regression.**

### Watch it work

```bash
npx appbacktest run --watch
```

Opens a real Chrome window, slows the run to human speed, and draws a cursor
that glides to whatever the simulated user is about to click — with a bar
along the bottom showing the goal, the step number, and the current action
(including "thinking about the next step…" while the model decides).

![Watch mode](docs/watch-mode.png)

This is the fastest way to understand a failure: reading a trace tells you
*what* happened, watching tells you *why*. The overlay is excluded from the
agent's perception and cannot receive pointer events, so watching a run never
changes what the run does. Use plain `--headed` for a real-speed browser
window without the overlay.

### With a real model

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
npx appbacktest run --config examples/pod-app/appbacktest.anthropic.yaml --headed
```

Same world, but a real model figures out the flow from perception alone —
watch it in the headed browser. Two live provider types:

- **`anthropic`** — schema-forced tool calls (the model structurally cannot
  answer in prose). Any Anthropic model via `provider.model`.
- **`openai_compatible`** — any `/v1/chat/completions` endpoint: NVIDIA NIM
  (free tier), OpenAI, Ollama, vLLM. Prompted vocabulary + hardened JSON
  extraction (reasoning tags stripped, fences unwrapped, balanced-brace scan);
  the zod gate still makes invalid actions impossible.

```yaml
provider:
  type: openai_compatible
  baseUrl: https://integrate.api.nvidia.com/v1
  model: nvidia/nemotron-3-super-120b-a12b
  apiKeyEnv: NVIDIA_API_KEY          # omit for keyless endpoints like Ollama
```

#### Running it for free

You do not need a paid API key to use AppBacktest with a real model. Three
free routes, all through the same `openai_compatible` provider:

| Route | Cost | Limits | Setup |
|---|---|---|---|
| **NVIDIA NIM** | free | per-model congestion, no daily cap | key at [build.nvidia.com](https://build.nvidia.com) |
| **OpenRouter** (`:free` models) | free | 20 req/min · 50 req/day (1000 after $10 lifetime spend) | key at [openrouter.ai/keys](https://openrouter.ai/keys) |
| **Ollama** | free | your own hardware | `baseUrl: http://localhost:11434/v1`, drop `apiKeyEnv` |

One scenario run costs roughly one request per step (~5–6 for the demo), so
OpenRouter's free 50/day is about 8 runs — fine for validation, tight for
iteration. NIM has no daily cap and is the better default; when a specific
model there is congested, the other pool usually isn't.

Ready-to-run configs: `appbacktest.nim.yaml`, `appbacktest.openrouter.yaml`,
`appbacktest.anthropic.yaml`. Verified live on NIM: `nemotron-3-super-120b`
(fast, ~6s/step) and `z-ai/glm-5.2` (reasoner, ~20s/step) both complete the
scenario correctly.

`examples/pod-app/appbacktest.nim.yaml` is ready to run. In live testing,
Nemotron-3-Super discovered the planted bug in its own way — it re-clicked
"Upload POD" when feedback felt slow, stacked onto the seeded double-click,
created **three** POD records, and confidently reported success. The state
check disagreed. That's the product.

## Using it on your app

```bash
cd your-app
npx appbacktest init      # writes appbacktest.yaml + .backtests/ + gitignore split
npx appbacktest run       # exit code = number of failed runs
```

```yaml
# appbacktest.yaml
app:
  name: My App
  url: http://localhost:3000
  command: npm run dev                        # optional: started + polled + killed
  resetHook: { method: POST, url: /api/test/reset }   # determinism contract for stateful apps

provider:
  type: anthropic                             # or { type: fixture, path: ./decisions.json }
  model: claude-opus-5
  effort: low

personas:                                     # reusable trait bundles
  hurried_operator:
    device: desktop                           # or mobile
    patience: low                             # low=12 / normal=20 / high=30 max steps
    doubleClickChance: 0.3                    # executor-level, seeded — a real human mistake
    uploadSizeKB: 2000
    traits: ["in a hurry", "not technical"]   # steer the agent's intent

scenarios:                                    # a goal and its proof, side by side
  order_flow:
    persona: hurried_operator
    goal: >
      Add two of the cheapest widget to your cart and check out. Make sure
      the order actually went through.
    checks:
      - { type: text, contains: "Order confirmed" }
      - { type: http, url: /api/orders, count: 1 }              # exactly one!
      - { type: http, url: /api/cart, path: items, count: 0 }
      - { type: no_text, contains: "error" }

runs: 5                                       # each run gets its own sub-seed
browser: { headless: true, actionTimeoutMs: 8000 }
```

Check types: `url` / `text` / `no_text` / `transient` / `element` /
`no_element` (role + accessible name) / `http` (GET through the browser
session — cookies flow — with `path` dot-walking, `count`, `equals`,
`expectStatus`). `http` checks are the workhorse: *"exactly one order
exists"* is something no toast can lie about. Use `transient` (not `text`)
for toasts and aria-live messages — they auto-dismiss, so they're asserted
against the recorded trace ("the user was shown X"), never raced against the
final DOM.

### CLI

| Command | What it does | Exit code |
|---|---|---|
| `appbacktest init` | scaffold config + artifact tree | |
| `appbacktest run [--seed N] [--scenario name] [--headed] [--watch]` | run the backtest, streaming every step (`--watch` = visible browser, slowed, cursor + HUD) | failed runs |
| `appbacktest replay <runId>` | strict replay — recorded trace, recorded perturbations, **no LLM ever** | 0 fixed · 1 reproduced · 2 diverged · 3 inconclusive |
| `appbacktest promote <runId>` | copy run + evidence into `.backtests/regressions/` (commit that dir) | |
| `appbacktest regression` | strict-replay every fixture; REPRODUCED **and** DIVERGED fail the gate | gate failures |
| `appbacktest list` | recorded runs + fixtures | |

Every run leaves a self-contained evidence bundle in `.backtests/runs/<id>/`:
the full `record.json` (actions, resolved targets, perturbations, console and
network deltas, toasts, dialogs, timings, frozen checks) plus a screenshot
per step. Paths inside records are POSIX-relative — fixtures committed from
Windows replay on Linux CI.

### Library

```ts
import { runBacktest } from "appbacktest";

const report = await runBacktest({ configPath: "appbacktest.yaml", seed: "555001" });
if (report.totals.discrepancies > 0) {
  // the app lied to a user this run
}
```

## How it works

```
seed ──► world generator ──► personas · perturbation schedules · sub-seeds   (pure, deterministic)
                 │
                 ▼
      ┌── run loop (engine) ──────────────────────────────────────┐
      │  perceive (DOM walk → roles + accessible names, no HTML)  │
      │  decide   (LLM or fixture — forced tool call, strict      │
      │            schema: the model cannot answer in prose)      │
      │  act      (identity re-verified at dispatch; seeded       │
      │            double-click fires both clicks in one task)    │
      │  record   (self-contained trace + evidence)               │
      └──────────────────────────────────────────────────────────┘
                 │
                 ▼
   observers (console/page/network errors, dialogs, give-ups)
   evaluators (checks vs real app state — never the agent's opinion)
                 │
                 ▼
   verdict · discrepancy flags · report · replayable RunRecord
```

Two layers of determinism, honestly separated:

1. **Plan determinism (absolute).** `seed → world` through pure seeded code.
   Sub-seeds key on stable identity (`seed:scenario:i`), and forked RNG
   streams derive from label paths — adding a scenario or a new consumer of
   randomness can never reshuffle an existing world.
2. **Trace determinism (recorded).** LLMs are nondeterministic, so every run
   records its decisions. `replay` consumes **only the record** — recorded
   actions, recorded perturbations, frozen checks — no LLM, no RNG (a test
   asserts replay draws zero randomness). `FIXED` requires positive evidence:
   every replayed step's re-resolved target must match the recorded one and
   the originally-failing check must flip. Anything less is `DIVERGED`, which
   fails the gate — a UI refactor can't quietly diverge your fixtures green.

## For AI coding agents

AppBacktest is a plain CLI + JSON reports, so Claude Code / Codex / Cursor
can drive it directly: implement a feature → `appbacktest run` → read
`.backtests/reports/latest.json` → investigate the evidence bundle → fix →
`appbacktest replay <id>` → `appbacktest regression`.

Anti-gaming is stated honestly: reports embed the check definitions verbatim
and a config hash, so evaluator edits are **visible in PR diffs** — that plus
a committed `.backtests/regressions/` under code review is the enforcement
point. (An agent that controls the app can still make the app's own state
endpoint lie; the independent DB oracle is on the roadmap. We don't claim
otherwise.)

## Honest limitations (v0.1)

- Chromium only; single actor per run (no concurrent multi-user simulation yet).
- Perception blind spots: closed shadow DOM, canvas UIs, virtualized lists,
  drag-and-drop.
- Network fault injection (latency/drops/offline) was deliberately cut from
  v0.1 — the naive version reproduced by luck, not by seed; it returns
  identity-keyed (per-request-pattern) on the roadmap.
- `http` checks trust the app's own API as oracle.
- Races: strict replay reproduces the exact recorded *stimulus* (same-task
  double dispatch); a genuinely nondeterministic app can still behave
  differently — replay grades honestly rather than pretending.

## Roadmap

Multi-actor concurrency · identity-keyed fault injection · invariants
(property-based checks over app state) · DB evaluators · `compare build-A
build-B` · HTML report · more providers (OpenAI, local models) · mobile/API
adapters · LLM-assisted UX judgment (as advisory, never as verdict).

`DESIGN.md` records the full architecture, the adversarial design review it
went through, and why each of these is sequenced where it is.

## Development

```bash
npm install && npx playwright install chromium
npm test          # 95 tests: seeded rng, config, worldgen, evaluators,
                  # observers, providers, engine replay semantics, real-chromium
                  # driver smoke, demo-app bug/fix behavior
npm run build
```

MIT © Jasroop Sangha
