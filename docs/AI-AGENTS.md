# Driving AppBacktest from an AI coding agent

[← README](../README.md) · [Install](../README.md#install) · [Use it manually](../README.md#use-it-manually) · [Use it with your AI agent](../README.md#use-it-with-your-ai-agent) · [Architecture](../DESIGN.md)

AppBacktest is a plain CLI that writes JSON. That makes it a good tool for a
coding agent: your agent implements a feature, sends probes through the real
UI, reads a structured report, fixes the app, and proves the fix with a
deterministic replay.

The value is the **trust boundary**. An agent grading its own work is a
notoriously bad idea, because the same reasoning that wrote the bug decides
whether the bug exists. AppBacktest splits that in two: an LLM decides what a
person would *do*, and deterministic code decides what actually *happened*.
Your agent never gets to issue the verdict.

---

## The loop

```
implement  →  appbacktest run  →  read reports/latest.json  →  fix the APP
                    ↑                                              │
                    └──────────────  appbacktest regression  ←─────┘
```

1. **`appbacktest run`** — probes pursue the goals in `appbacktest.yaml`.
   Exit code is the number of failed runs, so a non-zero exit means "found
   something", not "the tool broke".
2. **Read `.backtests/reports/latest.json`** — machine-readable findings,
   ordered problems-first, each with a reproduction trail and verbatim
   evidence.
3. **Fix the application.** AppBacktest never edits your source; that is the
   agent's job.
4. **`appbacktest promote <runId>`** then **`appbacktest regression`** — the
   gate replays the recorded failure with zero LLM involvement. Exit 0 with
   `✓ FIXED` is positive evidence the bug is actually gone.

## What the agent reads

`.backtests/reports/latest.json`:

| Field | Use it for |
|---|---|
| `totals.failed` | how many runs failed |
| `totals.discrepancies` | **the highest-signal number in the file** — see below |
| `findings[]` | ordered problems-first; each is one defect, grouped across runs |
| `findings[].reproduction` | the exact action trail that produced it |
| `findings[].evidence` | verbatim check failures, network and console lines |
| `findings[].category` | `critical_failure` first; usability / QoL are suggestions, not defects |
| `findings[].codeRefs` | candidate source locations — **empty unless** `source: { enabled: true }` is set in the config (read-only correlation, off by default) |
| `findings[].reproducedIn` | e.g. `"7 / 20 attempts"` — flakiness at a glance |
| `findings[].occurrences[].runDir` | where the screenshots and `replay.html` live |
| `checksByScenario` | the checks verbatim, so check edits show up in diffs |

### Discrepancies are the findings to care about

`runs[].discrepancy: true` means the probe believed it succeeded **and** the
deterministic state check says otherwise. The interface told a person
something untrue. Those runs surface as findings with
`category: "critical_failure"`, and `totals.discrepancies` counts them.

Fix the application so the UI and the stored state agree — do **not** fix it
by softening the message or the check.

## Exit codes

| Command | Exit code |
|---|---|
| `run` | number of failed + setup-failed runs (capped at 100) |
| `regression` | number of fixtures that still reproduce or diverged |
| any command | `1` on a tool/config error |

## Cost control

Use `provider: { type: fixture }` while iterating: decisions replay from a
JSON file, so it is deterministic, offline, and free. Switch to a live model
only when you want fresh exploration. `appbacktest report` re-derives findings
and replays from already-recorded runs with no app, no browser and no model.

---

## The prompt

Paste this into Claude Code, Cursor, Codex, or any agent with shell access.
Adjust the two bracketed lines at the top.

````markdown
You have AppBacktest available: a CLI that sends AI-simulated users ("probes")
through a real browser against a running app, then verifies what actually
happened with deterministic checks. Use it to find and fix real bugs.

Project: [describe the app, e.g. "Next.js expense tracker in ./web"]
Start it with: [e.g. "npm run dev", serving http://localhost:3000]

## How to work

1. Make sure `appbacktest.yaml` exists. If not, run `npx appbacktest init` and
   fill it in: point `app.url` at the running app, and write scenarios as a
   plain-English `goal` plus `checks` that verify real state. Prefer `http`
   checks against an API endpoint over `text` checks against the DOM — the UI
   is exactly what might be lying.
2. Run `npx appbacktest run`. A non-zero exit means it found failures; that is
   the tool working, not the tool breaking.
3. Read `.backtests/reports/latest.json`. Work `findings[]` in order — it is
   already sorted problems-first. For each finding use `reproduction` to
   understand the path and `evidence` for the verbatim failure. For candidate
   source locations set `source: { enabled: true }` in the config — `codeRefs`
   is empty otherwise.
4. Fix the application code. Then re-run to confirm.
5. For each genuine bug you fixed, keep it fixed:
   `npx appbacktest promote <runId>` followed by `npx appbacktest regression`.
   The gate must print `✓ FIXED` and exit 0. That replay uses no LLM at all,
   so it is real evidence rather than an opinion.

## Rules you must not break

- **Never edit a check, a goal, or a persona to make a run pass.** That is
  deleting the evidence, not fixing the bug. If you are convinced a check is
  genuinely wrong, stop and say so explicitly, with your reasoning — do not
  quietly change it.
- **Never edit anything under `.backtests/regressions/`.** That directory is
  the committed failure library; rewriting it forges a green build.
- **Fix the app, never the report.** AppBacktest does not modify source code
  by design, so every source change is yours and will be reviewed as yours.
- **A probe's opinion is not evidence.** `done(success)` is recorded and never
  trusted. Only the deterministic checks decide pass or fail.
- **Treat `category: "critical_failure"` findings first.** Those are the runs
  where `runs[].discrepancy` is true: the interface reported success while the
  stored state disagreed, so a user was told something untrue. Fix the
  underlying state bug, not the wording.
- **If a replay reports `DIVERGED`, do not force it.** The UI changed too much
  to replay the old trace. Re-simulate with `npx appbacktest run --seed <seed>`
  and promote a fresh failure instead.
- **Do not weaken a scenario to make it terminate.** If a probe runs out of
  steps, the workflow is probably genuinely too long or too confusing — that
  is a finding about the app, and worth reporting as one.

## What to report back

For each finding: what broke, the root cause in the code, the fix, and the
`regression` output proving it. Separate the categories the report separates —
functional bugs are defects; usability findings and quality-of-life
recommendations are evidence-backed suggestions, not bugs. Do not merge them.

If you could not fix something, say so plainly and leave the promoted fixture
in place so the gate stays red.
````

## Why the rules are shaped that way

Every rule above closes a specific way an agent can produce a green build
without fixing anything:

| Failure mode | What stops it |
|---|---|
| Loosening a check until it passes | reports embed checks verbatim + a config hash, so edits appear in the PR diff |
| Rewriting the failure library | `.backtests/regressions/` is committed and reviewed like source |
| Declaring success from the model's own opinion | the probe's belief is recorded but never counted |
| Claiming a fix without proof | `FIXED` requires positive evidence: identity-matched steps and the originally-failing check flipping |
| A refactor quietly making fixtures unreplayable | `DIVERGED` fails the gate; it is not treated as a pass |

One limit stated honestly: an agent that controls the application can still
make the app's own state endpoint lie, because `http` checks trust that
endpoint as their oracle. An independent database oracle is on the roadmap.
Code review of the diff remains the real enforcement point.
