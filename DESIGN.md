# AppBacktest — Design Document

[← README](README.md) · [Install](README.md#install) · [Use it manually](README.md#use-it-manually) · [Use it with your AI agent](README.md#use-it-with-your-ai-agent) · [The agent prompt](docs/AI-AGENTS.md)

> Backtesting, but for software applications. Probes (AI-simulated users) pursue goals
> through your real UI; deterministic code verifies what actually happened;
> seeded worlds make failures replayable regressions.

This is the design contract for v0.1. Before implementation, the architecture
was put through an adversarial four-lens critique (determinism/replay,
agent-browser interface, trust/evaluation, scope/DX — ~60 findings). Material
findings and the decisions they forced are inline, marked **[critique]**.

---

## 1. Critical analysis of the idea

The core insight is sound and genuinely different from scripted E2E testing:

- **Scripted E2E** answers "does the path I predicted still work?" It cannot
  discover failures on paths nobody scripted.
- **AppBacktest** answers "does the application survive a plausible human?" —
  including the human who double-clicks submit and retries when feedback is
  slow. The interesting bugs (duplicate records, lost state, races) live in
  the gap between the happy path and real behavior.

The load-bearing idea — what keeps this from being an AI toy — is the **trust
boundary**: the LLM generates *behavior*; deterministic code issues the
*verdict*. An agent claiming "upload succeeded" is data, not truth. The
framework independently asserts application state and flags belief/verdict
**discrepancies** as first-class results. The separation is structural, not
prompted: agent output is schema-constrained to a closed action vocabulary,
and the evaluator never reads the agent's opinion.

### The hardest technical problems (ranked)

1. **LLM nondeterminism vs "replay 739281".** You cannot make a model
   deterministic. Solution: *two-layer determinism* (§4). The seed
   deterministically generates the world; every run records its full trace;
   replay executes the *recorded trace* with no LLM in the loop.
2. **Replaying against a changed application.** A trace recorded on build 42
   may not apply to build 43. Replay is *graded*: `REPRODUCED` / `FIXED` /
   `DIVERGED` / `INCONCLUSIVE`. **[critique]** `FIXED` requires positive
   evidence, not mere check-pass: every replayed step's re-resolved target
   must match the recorded descriptor, the trigger perturbation must actually
   have executed, and the fixture's originally-failing check must now pass.
   Any identity mismatch ⇒ `DIVERGED` (with first-divergent step + reason) —
   never a silent wrong-element click graded green. `DIVERGED` is
   **gate-not-satisfied** in CI (nonzero exit): a UI refactor cannot quietly
   diverge every fixture to green.
3. **Reproducing timing-dependent bugs.** **[critique]** Two sequential
   awaited Playwright clicks do NOT reproduce a double-click race (the first
   response can land before the second click). The double-click perturbation
   is therefore dispatched as two click calls in the *same task* with no
   await between them, and the mechanism is recorded in the trace. Strict
   replay also restores the settle time the LLM round-trip used to provide
   for free: each step waits until the recorded pre-step state is reachable
   (locator resolvable, URL matching) or the recorded elapsed time has
   passed — without this readiness gate, machine-speed replay diverges on
   any async UI.
4. **Perception fidelity without giving the agent internals.** The agent sees
   an element inventory (role + accessible name + state) and a text digest —
   never selectors or HTML. **[critique]** The DOM walk pierces open shadow
   roots, walks iframes (frame-scoped refs), computes real accessible names
   (label[for], ancestor label, aria-labelledby, title — not just innerText),
   includes `<select>` options, flags occluded elements when a modal is open,
   and treats "visible" as *attached and not hidden*, NOT in-viewport (so
   below-fold content is reachable; Playwright auto-scrolls on click).
   Documented v0.1 blind spots: closed shadow DOM, canvas UIs, virtualized
   lists, drag-and-drop.
5. **Harness honesty.** **[critique]** The executor can silently misclick if
   the DOM mutates between perceive and act (SPA re-renders, node recycling)
   — which would poison the discrepancy data with harness error. Every
   element-targeted action re-verifies the node's {role, name} identity at
   dispatch time; a mismatch fails the step with a typed `stale_target`
   error instead of clicking the wrong thing.
6. **Cost.** Thousands of LLM calls per big run. Mitigations: compact
   decision contexts (history is one-line entries; full perception for the
   current step only; digest ≤ ~1.5KB), low-effort decision calls, and the
   LLM-free paths (fixture provider, strict replay, regression) cost zero.

### What in the original spec is unrealistic (and what v0.1 does instead)

- **"Replay recreates the failure reliably"** — true for deterministic bugs;
  for races we replay the exact recorded stimulus and grade honestly.
- **"Compare builds under the same simulations"** — same *world*, not same
  *actions* (the agent may path differently on a changed UI). `compare` is
  deferred until those semantics can be stated honestly.
- **"AI discovers UX failures"** — LLM-judged UX has a high false-positive
  rate. v0.1 keeps UX signals objective — give-ups, step overage, and
  **reverse discrepancies** (agent believed it failed; checks say the app
  worked — a real usability finding, surfaced not discarded).
- **"Permission leaks / lost state"** as advertised bug classes —
  **[critique]** not fully catchable with v0.1's check set and single-actor
  runs. v0.1 adds `no_text` / `no_element` negative checks and `expectStatus`,
  which cover some leak probes, but cross-identity assertions and baseline
  capture are roadmap. The pitch claims what v0.1 catches: duplicate/state
  bugs via app-state assertions, belief/reality gaps, browser-level errors.
- **"Reliability score drives the loop until threshold"** — a score gating an
  AI coding agent will be Goodharted, and at small N a composite is noise.
  **[critique]** v0.1 ships **no composite score**: reports show unbundled
  components (pass k/N, discrepancies, error observations). Regressions are
  the hard gate. The config hash is **tamper-evidence, not tamper-proofing**
  (§4 trust) — and reports embed check definitions verbatim so evaluator
  edits show up in PR diffs, which is where enforcement actually lives.

### Deliberate v0.1 cuts forced by the critique

- **Network fault injection** (latency/drops/offline) — cut entirely.
  The counter-based schedule pinned position, not victim identity, so it
  reproduced by luck; identity-keyed injection (method + URL pattern +
  occurrence) returns on the roadmap. Nothing in the v0.1 proof needs it,
  and cutting it removes the self-inflicted observer noise problem.
- **`--resim`** — cut; it was `run --seed <recorded>` wearing a costume.
  `replay` has exactly one meaning: deterministic, LLM-free, always. When
  a fixture diverges, the CLI prints the live-rerun command verbatim.
- **Composite score, typo perturbation, nav-loop and slow-action observers**
  — cut (unexercised heuristics or Goodhart bait).

---

## 2. Product shape

CLI-first, local-first, open-source (MIT). No SaaS, no accounts, no hosted
anything. The engine is a library (`import { ... } from "appbacktest"`); the
CLI is a thin shell over it. Artifacts live in the project's `.backtests/`.
Claude Code / Codex / CI are *users* of the CLI and library, never
dependencies of it.

**[critique] First-run experience is a design requirement:** the golden path
is zero-key (`npm run demo` → fixture provider + planted-bug app → the full
discover→replay→fix→regression loop, deterministic on every machine). Live
runs stream every step to the terminal as it happens (a silent multi-minute
LLM run looks hung), `--headed` shows the real browser, and `run` preflights
(config, app reachable — or starts it via `app.command` — browser installed,
API key present when needed) with one-line actionable errors.

## 3. v0.1 boundaries

**In:** web apps · local · Playwright Chromium · CLI (`init`, `run [--seed]
[--scenario] [--headed]`, `replay <runId>`, `promote <runId>`, `regression`,
`list`) · YAML config (zod, discriminated unions, unknown keys are errors) ·
seeded world generation (personas, perturbation schedules, stable sub-seeds)
· goal-based agent · providers: `anthropic` (default `claude-opus-5`,
schema-forced tool calls), `openai_compatible` (any chat-completions
endpoint — NVIDIA NIM / OpenAI / Ollama — prompted vocabulary + hardened
JSON extraction + 429/5xx backoff; live-validated on NIM), and `fixture`
(zero-key) · perception per §4 · closed action vocabulary
(navigate/click/type/select/upload/press/scroll/back/wait/done/give_up) ·
double-click perturbation (same-task double dispatch) · filechooser
interception + hidden-input upload resolution · dialog handling (recorded,
surfaced to agent) · popup adoption · toast/aria-live capture · observers
(console errors, page errors, failed requests w/ ERR_ABORTED ignored,
HTTP ≥ 400, action errors, auto-handled dialogs, give-ups, step overage;
ignore patterns configurable) · checks (`url`, `text`, `no_text`,
`transient` — toasts/aria-live asserted against the recorded trace, since
agent think-time outlives auto-dismissing toasts — `element`, `no_element`,
`http` GET-only via browser-context request with status/path/count/equals,
settle-and-poll policy) · verdicts PASS / FAIL / SETUP_FAILED
with failure precedence setup_failed > technical > check_error > assertion ·
structural agent belief (done outcome enum) · discrepancy + reverse-
discrepancy flags · passedWithObservations · self-contained RunRecords
(POSIX-relative paths, frozen checks, format+tool versions) · strict replay
with readiness gate + positive-evidence FIXED · promote (evidence bundle
copied, paths rewritten) · regression runner (REPRODUCED and DIVERGED both
fail the gate; INCONCLUSIVE for harness/setup failures) · terminal + JSON
reports · example POD app with planted bug (hidden file input, like real
apps) · vitest suite for the deterministic core.

**Out (roadmap):** multi-actor concurrency · identity-keyed network fault
injection · invariants engine · DB evaluators (the independent oracle) ·
`compare` · HTML report · product discovery · mobile/API adapters · levels ·
LLM UX judge · further providers beyond anthropic/openai-compatible (the
`AgentProvider` seam held: `openai_compatible` shipped as one new file with
zero engine changes) · baseline capture /
`ui-matches-api` checks · multi-identity permission probes · virtualized-list
paging · drag-and-drop.

## 4. Architecture

### Module map (each = one directory under `src/`)

| Module | Responsibility | Depends on |
|---|---|---|
| `core` | types (the contract), seeded RNG, config schema+loader, world generator, hashing, ids | nothing |
| `providers` | `AgentProvider` impls: anthropic, fixture | core |
| `browser` | `PlaywrightDriver`: perception walk, action dispatch + identity re-verification, perturbations, uploads, incident capture | core |
| `observers` | derive `Observation[]` from steps/incidents | core |
| `evaluators` | run checks against page + HTTP; merge verdict | core |
| `engine` | run loop; recorder; replayer; regression runner; app lifecycle | core (driver & provider injected via interfaces) |
| `reporting` | terminal + JSON reports | core |
| `cli` | commander wiring; composition root; preflight | everything |

The engine never imports Playwright or an LLM SDK — it depends on the
`AgentProvider`/`BrowserDriver` interfaces in `core/types.ts`. The CLI is the
only composition root.

### The run loop

```
preflight → app start (app.command?) → resetHook (fail ⇒ SETUP_FAILED, quarantined)
driver.start()
loop until done/give_up/maxSteps/fatal:
  perception = driver.perceive()            # fresh walk, refs tagged
  screenshot
  action = provider.decide({goal, persona, compact history, perception})
  outcome = driver.act(action, {persona, rng})   # identity re-verify → dispatch (+ seeded double-click)
  incidents = driver.drainIncidents()            # console/network/toasts/dialogs/tabs
  record StepRecord; stream step line to terminal; feed outcome+feedback into next history entry
evaluators: settle (networkidle ≤3s) → run checks (poll failing ≤4s) → CheckResults
observers: derive from steps+incidents (ignore patterns applied)
evaluation: verdict + belief + discrepancy flags → RunRecord → report
```

### Determinism model (seeds ⇄ LLM)

- **Layer 1 — plan determinism (absolute).** `seed → WorldPlan` via pure
  seeded code. Sub-seeds key on *stable identity* (`seed:scenarioKey:i`),
  never position — adding a scenario cannot shift another's world.
  `rng.fork(label)` derives child streams purely from the label path (never
  by consuming parent draws), so adding a consumer of randomness cannot
  reshuffle siblings. Tested property, not a hope.
- **Layer 2 — trace determinism (recorded).** The LLM's decisions are
  nondeterministic, so runs record them. **Strict replay consumes only the
  RunRecord** — recorded actions, recorded perturbations, recorded typed
  strings, recorded upload recipe — and touches no PRNG and no LLM. The seed
  in a fixture is provenance metadata. This is what makes fixtures survive
  appbacktest upgrades.

### Trust & evaluation

- Checks run after the agent finishes, regardless of belief. `http` checks go
  through the **browser context's request client** so cookies/session flow —
  the evaluator sees the app as the logged-in user does (Node-side fetch
  would 401 on any authed app and generate false discrepancies).
- "Check evaluated false" (`assertion`) is distinct from "check could not
  evaluate" (`check_error`) — only clean assertion failures can raise a
  discrepancy or grade a regression `REPRODUCED`.
- Belief is structural: `done(outcome: success|unsure, summary)`; `give_up`
  implies failure. No prose parsing. `unsure` never raises a discrepancy.
- Observations never flip a verdict in v0.1, but a PASS carrying
  error-severity observations is reported as `passedWithObservations` —
  a green run that threw 500s is visibly suspect, never silently clean.
- **Trust boundary stated honestly:** `http` checks use the app under test as
  their own oracle. A coding agent that controls the app can make the oracle
  lie without touching a single evaluator. The config hash + verbatim checks
  in reports make tampering *evident* under an externally protected baseline
  (committed fixtures + code review); the independent oracle (DB evaluator)
  is the roadmap fix. We do not claim more than this.

### Replay & regression semantics

- `replay <runId>`: reset (required for fixtures with state checks; refuses
  to grade on reset failure ⇒ INCONCLUSIVE) → per step: readiness gate
  (locator resolvable + URL match, up to recorded elapsed) → identity-checked
  dispatch with recorded perturbations → grade against the record's frozen
  checks. Outcomes: `REPRODUCED` (frozen checks still fail cleanly), `FIXED`
  (positive evidence, §1.2), `DIVERGED` (identity/post-condition mismatch,
  with step + reason + verbatim live-rerun hint), `INCONCLUSIVE` (harness or
  setup failure — never a grade).
- `promote <runId>` copies the record + evidence bundle into
  `.backtests/regressions/<runId>/`, paths rewritten relative.
- `regression` replays every fixture; exit code = REPRODUCED + DIVERGED
  count (capped 100). `.backtests/runs/` is gitignored; **`regressions/` is
  meant to be committed** — init writes exactly that split.

## 5. Configuration format

```yaml
# appbacktest.yaml
app:
  name: POD Demo
  url: http://localhost:4173
  command: node examples/pod-app/server.js   # optional; started+polled+killed
  resetHook: { method: POST, url: /api/reset }

provider:
  type: anthropic            # or: { type: fixture, path: ./fixtures/driver.json }
  model: claude-opus-5
  effort: low

personas:                    # reusable trait bundles — no goals here
  driver:
    device: desktop
    patience: normal         # low=12 / normal=20 / high=30 max steps
    doubleClickChance: 0.35  # executor-level, seeded — not LLM flavor
    uploadSizeKB: 400
    traits: ["in a hurry", "not technical"]

scenarios:                   # goal and its proof live side by side
  pod_upload:
    persona: driver
    goal: >
      You are a truck driver. Upload a proof-of-delivery photo for load
      #38419 and make sure it was accepted.
    checks:
      - { type: url,  contains: "/loads/" }
      - { type: text, contains: "Upload received" }
      - { type: http, url: /api/loads/38419/pods, count: 1 }

runs: 1
browser: { headless: true, actionTimeoutMs: 8000 }
```

Zod validates with YAML-path error messages; unknown keys are errors;
provider is a discriminated union (each variant's missing fields fail
specifically). The CLI warns loudly when http count/equals checks exist
without a resetHook (state outside the seed breaks "same seed, same run").

## 6. Directory structure

```
appbacktest/
├── src/
│   ├── core/          types.ts, rng.ts, config.ts, worldgen.ts, hash.ts, ids.ts
│   ├── providers/     anthropic.ts, fixture.ts, index.ts
│   ├── browser/       driver.ts, perception.ts (injected walker), uploads.ts
│   ├── observers/     index.ts
│   ├── evaluators/    index.ts, jsonpath.ts
│   ├── engine/        runner.ts, recorder.ts, replayer.ts, regression.ts, appProcess.ts
│   ├── reporting/     terminal.ts, json.ts
│   ├── cli/           index.ts, init.ts, preflight.ts
│   └── index.ts       (library API)
├── examples/pod-app/  server.js, public/, appbacktest.yaml, fixtures/
├── tests/             vitest — deterministic core
├── DESIGN.md · README.md · LICENSE
└── .backtests/
    ├── runs/<runId>/record.json + steps/*.png     (gitignored)
    ├── regressions/<runId>/record.json + evidence (COMMITTED)
    └── reports/latest.json
```

All artifact paths inside records are POSIX-style and relative to the
record's own directory — fixtures committed from Windows replay on Linux CI.

## 7. Phased implementation plan

1. **Core** — rng (label-path forks), config, worldgen, hashing (+ stability
   tests: adding a scenario/perturbation must not shift sibling streams).
2. **Boundaries** — providers (anthropic: forced tool call + strict schema;
   fixture) and the Playwright driver (walker, identity re-verification,
   filechooser, incidents).
3. **Judgment** — observers + evaluators (+ golden semantics tests).
4. **Engine** — run loop, recorder, replayer (readiness gate, positive-
   evidence FIXED), regression runner, app lifecycle.
5. **Surface** — reporting, CLI, init, preflight, library entry.
6. **Proof** — POD example app (hidden file input + styled button, real-app
   shaped; `FIXED=1` repair flag); run the loop live: discover → replay
   REPRODUCED → fix → regression FIXED.
7. **Hardening** — review pass, README with real output.

## 8. Constraints carried forward (for contributors)

- The engine must never import Playwright or an LLM SDK.
- No LLM does work deterministic code can do.
- Strict replay consumes the record only — a test asserts it draws zero PRNG.
- Every bounded thing states its bound; no silent truncation.
- Reports stay honest: discrepancies, divergences, setup failures, and
  passed-with-observations are surfaced, never folded into a rosier number.
- The executor never guesses a target: identity mismatch is a typed failure.
