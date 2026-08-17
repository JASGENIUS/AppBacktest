#!/usr/bin/env node
/**
 * Full feature verification for AppBacktest.
 *
 * Exercises every user-facing capability end to end against the bundled
 * example apps using the fixture provider — deterministic, offline, free —
 * and prints a pass/fail matrix. Live-LLM providers are verified separately
 * (they need a key and a network).
 *
 *   node scripts/verify-features.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const CLI = join(ROOT, "dist", "cli", "index.js");
const POD = "examples/pod-app/appbacktest.yaml";
// Zero-key deterministic variant — verification must not depend on a live LLM.
const COVE = "examples/expense-app/appbacktest.fixture.yaml";
const POD_OUT = join(ROOT, "examples/pod-app/.backtests");
const COVE_OUT = join(ROOT, "examples/expense-app/.backtests");

const results = [];
let currentGroup = "";

const group = (name) => {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
};

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ group: currentGroup, name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  } catch (err) {
    results.push({ group: currentGroup, name, ok: false, err: String(err.message ?? err) });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${String(err.message ?? err).slice(0, 300)}\x1b[0m`);
  }
}

/** Run the CLI; returns {code, out}. Never throws on non-zero exit. */
function cli(args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * Run the CLI and REQUIRE the expected exit code. Without this a failed
 * command silently leaves the previous report on disk and every later
 * assertion reads stale data — a verification that flatters itself.
 */
function cliOk(args, expectedCode = 0, env = {}) {
  const r = cli(args, env);
  assert(
    r.code === expectedCode,
    `\`${args.join(" ")}\` exited ${r.code}, expected ${expectedCode}\n${r.out.slice(-500)}`,
  );
  return r;
}

/** Read latest.json and prove it was written by the command we just ran. */
function freshReport(outDir, notOlderThanMs = 10 * 60 * 1000) {
  const path = join(outDir, "reports/latest.json");
  assert(existsSync(path), `no report at ${path}`);
  const rep = readJson(path);
  const age = Date.now() - Date.parse(rep.finishedAt);
  assert(
    Number.isFinite(age) && age >= 0 && age < notOlderThanMs,
    `report is stale (finishedAt ${rep.finishedAt}) — the command under test did not write it`,
  );
  return rep;
}
const latestReport = (outDir) => freshReport(outDir);

// ---------------------------------------------------------------------------
group("CLI scaffolding");

check("init creates config, artifact tree and gitignore split", () => {
  const dir = mkdtempSync(join(tmpdir(), "abt-verify-"));
  try {
    const r = execFileSync(process.execPath, [CLI, "init"], { cwd: dir, encoding: "utf8" });
    assert(existsSync(join(dir, "appbacktest.yaml")), "appbacktest.yaml missing");
    assert(existsSync(join(dir, ".backtests/regressions")), "regressions dir missing");
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert(gitignore.includes(".backtests/runs/"), "runs/ not gitignored");
    assert(!gitignore.includes(".backtests/regressions"), "regressions must stay committed");
    assert(r.includes("Next steps"), "no guidance printed");
    return "yaml + tree + gitignore";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("init refuses to overwrite an existing config", () => {
  const dir = mkdtempSync(join(tmpdir(), "abt-verify-"));
  try {
    writeFileSync(join(dir, "appbacktest.yaml"), "app: {}");
    let failed = false;
    try {
      execFileSync(process.execPath, [CLI, "init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    } catch {
      failed = true;
    }
    assert(failed, "init overwrote an existing config");
    return "refuses to clobber";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
group("Discovery run (POD app, fixture provider)");

let podReport;
check("run discovers the planted duplicate-submit bug", () => {
  rmSync(join(POD_OUT, "runs"), { recursive: true, force: true });
  const r = cli(["run", "--config", POD, "--seed", "555001"]);
  assert(r.code === 2, `expected exit 2 (two failed runs), got ${r.code}`);
  assert(/DISCREPANCY/.test(r.out), "no discrepancy reported");
  podReport = latestReport(POD_OUT);
  assert(podReport.totals.total === 3, `expected 3 runs, got ${podReport.totals.total}`);
  assert(podReport.totals.discrepancies === 2, `expected 2 discrepancies, got ${podReport.totals.discrepancies}`);
  return `3 runs · 1 pass · 2 discrepancies · exit ${r.code}`;
});

check("exit code equals the number of failed runs (CI contract)", () => {
  assert(podReport.totals.failed === 2, "expected 2 failures");
  return "exit 2 == 2 failed";
});

check("evidence bundle written per run (record + screenshots + replay)", () => {
  const runDir = join(POD_OUT, "runs", podReport.runs[0].runId);
  assert(existsSync(join(runDir, "record.json")), "record.json missing");
  assert(existsSync(join(runDir, "steps/000.png")), "step screenshot missing");
  assert(existsSync(join(runDir, "replay.html")), "replay.html missing");
  const rec = readJson(join(runDir, "record.json"));
  assert(rec.formatVersion === 1, "bad format version");
  assert(rec.steps.every((s) => !s.screenshot || /^steps\/\d+\.png$/.test(s.screenshot)), "screenshot paths not POSIX-relative");
  assert(rec.checks.length > 0, "frozen checks missing from record");
  return `${rec.steps.length} steps · frozen checks · POSIX paths`;
});

check("seeded perturbation fires deterministically", () => {
  const withDouble = podReport.runs.filter((r) => {
    const rec = readJson(join(POD_OUT, "runs", r.runId, "record.json"));
    return rec.steps.some((s) => s.perturbations.some((p) => p.kind === "double_click"));
  });
  assert(withDouble.length === 2, `expected 2 runs with a double-click, got ${withDouble.length}`);
  return "2 of 3 runs double-clicked (seed 555001)";
});

// ---------------------------------------------------------------------------
group("Check types");

check("all check types evaluate (url, text, no_text, transient, element, no_element, http)", () => {
  const cfgPath = join(ROOT, "examples/pod-app/appbacktest.checks.yaml");
  const cfg = `app:
  name: POD Demo
  url: http://localhost:4173
  command: node server.js
  resetHook: { method: POST, url: /api/reset }
provider: { type: fixture, path: ./fixtures/driver.json }
personas:
  driver: { device: desktop, patience: normal, doubleClickChance: 0.0, uploadSizeKB: 100 }
scenarios:
  all_checks:
    persona: driver
    goal: Upload a proof-of-delivery photo for load #38419 and confirm it was accepted.
    checks:
      - { type: url, contains: "/loads/" }
      - { type: text, contains: "Proof of delivery" }
      - { type: no_text, contains: "Internal Server Error" }
      - { type: transient, contains: "Upload received" }
      - { type: element, role: button, name: "Upload POD" }
      - { type: no_element, role: button, name: "Delete everything" }
      - { type: http, url: /api/loads/38419/pods, count: 1 }
      - { type: http, url: /api/loads/38419, path: "status", equals: "in_transit" }
      - { type: http, url: /api/loads/99999, expectStatus: 404 }
runs: 1
browser: { headless: true, actionTimeoutMs: 8000 }
`;
  writeFileSync(cfgPath, cfg);
  try {
    const r = cli(["run", "--config", "examples/pod-app/appbacktest.checks.yaml", "--seed", "424242"]);
    const rep = latestReport(POD_OUT);
    const run = rep.runs.find((x) => x.scenarioKey === "all_checks");
    assert(run, "scenario did not run");
    const rec = readJson(join(POD_OUT, "runs", run.runId, "record.json"));
    const kinds = rec.evaluation.checkResults.map((c) => c.check.type);
    for (const t of ["url", "text", "no_text", "transient", "element", "no_element", "http"]) {
      assert(kinds.includes(t), `check type ${t} never evaluated`);
    }
    const errored = rec.evaluation.checkResults.filter((c) => c.errored);
    assert(errored.length === 0, `checks errored: ${errored.map((c) => c.detail).join("; ")}`);
    const failed = rec.evaluation.checkResults.filter((c) => !c.passed);
    assert(failed.length === 0, `checks failed: ${failed.map((c) => JSON.stringify(c.check) + " -> " + c.detail).join("; ")}`);
    assert(r.code === 0, `expected clean pass, exit ${r.code}`);
    return `9 checks · 7 types · all passed`;
  } finally {
    rmSync(cfgPath, { force: true });
  }
});

// ---------------------------------------------------------------------------
group("Replay, promote, regression");

let promotedId;
check("strict replay reproduces the discovered failure (no LLM)", () => {
  const failed = podReport.runs.find((r) => r.discrepancy);
  assert(failed, "no failing run to replay");
  promotedId = failed.runId;
  const r = cli(["replay", promotedId, "--config", POD]);
  assert(r.code === 1, `expected exit 1 (REPRODUCED), got ${r.code}`);
  assert(/REPRODUCED/.test(r.out), "did not report REPRODUCED");
  return "REPRODUCED · exit 1";
});

check("replay draws no randomness and consults no provider", () => {
  const dir = join(POD_OUT, "runs");
  const replayRecs = readdirSync(dir)
    .map((d) => join(dir, d, "record.json"))
    .filter((p) => existsSync(p))
    .map((p) => readJson(p))
    .filter((rec) => rec.replayOf === promotedId);
  assert(replayRecs.length > 0, "no replay record written");
  assert(replayRecs.every((rec) => rec.provider.type === "strict-replay"), "replay used a live provider");
  return "provider = strict-replay";
});

check("promote copies the run into the committed failure library", () => {
  rmSync(join(POD_OUT, "regressions"), { recursive: true, force: true });
  const r = cli(["promote", promotedId, "--config", POD]);
  assert(r.code === 0, `promote failed: ${r.out.slice(0, 200)}`);
  assert(existsSync(join(POD_OUT, "regressions", promotedId, "record.json")), "fixture not written");
  return `fixture ${promotedId.slice(0, 24)}…`;
});

check("regression gate is RED while the bug is present", () => {
  const r = cli(["regression", "--config", POD]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(/REPRODUCED/.test(r.out), "fixture did not reproduce");
  return "✗ REPRODUCED · exit 1";
});

check("regression gate turns GREEN when the bug is fixed", () => {
  const r = cli(["regression", "--config", POD], { FIXED: "1" });
  assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.out.slice(0, 300)}`);
  assert(/FIXED/.test(r.out), "fixture did not flip to FIXED");
  return "✓ FIXED · exit 0";
});

check("list shows runs and promoted fixtures", () => {
  const r = cli(["list", "--config", POD]);
  assert(r.code === 0, "list failed");
  assert(/runs:/.test(r.out) && /regressions:/.test(r.out), "sections missing");
  assert(r.out.includes(promotedId), "promoted fixture not listed");
  return "runs + regressions listed";
});

// ---------------------------------------------------------------------------
group("Findings, evidence and replay viewer");

let coveReport;
check("Cove run produces categorised findings", () => {
  rmSync(join(COVE_OUT, "runs"), { recursive: true, force: true });
  // Exit code is the failure count; the planted bug means this is expected to fail.
  const r = cli(["run", "--config", COVE, "--seed", "555001"]);
  assert(r.code > 0, `expected the planted bug to fail the run, exit ${r.code}\n${r.out.slice(-400)}`);
  coveReport = latestReport(COVE_OUT);
  assert(coveReport.findings.length > 0, "no findings produced");
  assert(coveReport.findingCounts, "findingCounts missing");
  const cats = new Set(coveReport.findings.map((f) => f.category));
  assert(cats.size >= 1, "no categories assigned");
  return `${coveReport.findings.length} findings · categories: ${[...cats].join(", ")}`;
});

check("every finding carries reproduction, evidence, confidence and occurrences", () => {
  for (const f of coveReport.findings) {
    assert(typeof f.confidence === "number" && f.confidence > 0 && f.confidence <= 1, `bad confidence on ${f.id}`);
    assert(f.evidence.length > 0, `no evidence on ${f.id}`);
    assert(f.occurrences.length > 0, `no occurrences on ${f.id}`);
    assert(/\d+ \/ \d+ attempts/.test(f.reproducedIn), `bad reproducedIn on ${f.id}`);
    assert(f.sourceModified === false, `sourceModified must be false on ${f.id}`);
  }
  return `${coveReport.findings.length} findings fully evidenced`;
});

check("findings carry a replay clip anchored to the failure moment", () => {
  const withClip = coveReport.findings.filter((f) => f.occurrences.some((o) => o.clip));
  assert(withClip.length > 0, "no finding carries a clip");
  const clip = withClip[0].occurrences.find((o) => o.clip).clip;
  assert(clip.entries.length > 0, "clip has no timeline entries");
  assert(clip.startMs <= clip.focusMs && clip.focusMs <= clip.endMs, "clip window malformed");
  return `clip ${clip.entries.length} entries · window ${clip.startMs}–${clip.endMs}ms`;
});

check("replay viewer is self-contained and references real screenshots", () => {
  const runId = coveReport.runs[0].runId;
  const html = readFileSync(join(COVE_OUT, "runs", runId, "replay.html"), "utf8");
  assert(html.startsWith("<!doctype html>"), "not an html document");
  assert(!/<script src=|href="https?:|src="https?:/.test(html), "viewer loads external resources");
  const shot = /src="(steps\/\d+\.png)"/.exec(html) ?? html.match(/steps\\\/\d+\.png/);
  assert(html.includes("steps/"), "no screenshot references");
  assert(existsSync(join(COVE_OUT, "runs", runId, "steps")), "screenshots dir missing");
  return "offline · file:// safe · screenshots present";
});

check("HTML report orders problems before recommendations", () => {
  const html = readFileSync(join(COVE_OUT, "reports/latest.html"), "utf8");
  const iBug = html.indexOf("FUNCTIONAL BUGS");
  const iUsability = html.indexOf("USABILITY ISSUES");
  const iQol = html.indexOf("QUALITY-OF-LIFE");
  const order = [iBug, iUsability, iQol].filter((i) => i >= 0);
  const sorted = [...order].sort((a, b) => a - b);
  assert(JSON.stringify(order) === JSON.stringify(sorted), "recommendations appear before real problems");
  assert(html.includes("Open Replay"), "no replay link in report");
  assert(html.includes("Source code modified: no"), "missing source-untouched statement");
  return "problems → usability → QoL";
});

check("report command re-derives everything offline (no app, no LLM)", () => {
  rmSync(join(COVE_OUT, "reports/latest.html"), { force: true });
  const r = cli(["report", "--config", COVE]);
  assert(r.code === 0, `report failed: ${r.out.slice(0, 200)}`);
  assert(existsSync(join(COVE_OUT, "reports/latest.html")), "html not regenerated");
  return "regenerated from recorded runs";
});

// ---------------------------------------------------------------------------
group("UX recommendations");

/**
 * Re-derive the report with a different ux block. The base config already
 * defines `ux:`, so it must be REPLACED — appending a second key is a
 * duplicate-key YAML error, which would fail the command and leave the
 * previous report in place.
 */
function reportWithUx(level, extra = "") {
  const rel = "examples/expense-app/appbacktest.ux.yaml";
  const path = join(ROOT, rel);
  const base = readFileSync(join(ROOT, COVE), "utf8")
    .replace(/^ux:\n(?:[ \t]+.*\n?)*/m, "") // drop the existing ux block
    .trimEnd();
  writeFileSync(path, `${base}\n\nux: { level: ${level}${extra} }\n`);
  try {
    cliOk(["report", "--config", rel]);
    return latestReport(COVE_OUT);
  } finally {
    rmSync(path, { force: true });
  }
}

check("conservative level surfaces evidence-backed usability findings", () => {
  const rep = reportWithUx("conservative");
  const ux = rep.findings.filter((f) => f.category === "usability" || f.category === "qol_recommendation");
  assert(ux.length > 0, "no UX findings at conservative");
  for (const f of ux) {
    assert(f.userImpact, `no userImpact on ${f.id}`);
    assert(f.suggestion, `no suggestion on ${f.id}`);
    assert(f.evidence.length > 0, `no evidence on ${f.id}`);
  }
  return `${ux.length} UX finding(s), each with impact + suggestion + evidence`;
});

check("off disables the system entirely", () => {
  const rep = reportWithUx("off");
  const ux = rep.findings.filter((f) => f.category === "usability" || f.category === "qol_recommendation");
  assert(ux.length === 0, `expected 0 UX findings, got ${ux.length}`);
  const bugs = rep.findings.filter((f) => f.category !== "usability" && f.category !== "qol_recommendation");
  assert(bugs.length > 0, "bug detection must be unaffected by ux: off");
  return `0 UX findings · ${bugs.length} bug finding(s) still reported`;
});

check("detailed surfaces at least as much as conservative", () => {
  const cons = reportWithUx("conservative").findings.filter((f) => f.category === "usability" || f.category === "qol_recommendation").length;
  const det = reportWithUx("detailed", ", maxRecommendations: 10").findings.filter((f) => f.category === "usability" || f.category === "qol_recommendation").length;
  assert(det >= cons, `detailed (${det}) surfaced fewer than conservative (${cons})`);
  return `conservative ${cons} → detailed ${det}`;
});

check("confidence threshold suppresses low-confidence friction", () => {
  const rep = reportWithUx("detailed", ", minConfidence: 0.99, maxRecommendations: 10");
  const ux = rep.findings.filter((f) => f.category === "usability" || f.category === "qol_recommendation");
  assert(ux.length === 0, `threshold ignored: ${ux.length} findings survived minConfidence 0.99`);
  return "minConfidence 0.99 → 0 findings";
});

check("hard cap limits recommendation volume", () => {
  const rep = reportWithUx("detailed", ", maxRecommendations: 1");
  const ux = rep.findings.filter((f) => f.category === "usability" || f.category === "qol_recommendation");
  assert(ux.length <= 1, `cap ignored: ${ux.length} findings`);
  return `maxRecommendations 1 → ${ux.length}`;
});

// ---------------------------------------------------------------------------
group("Multi-user (concurrent) scenarios");

const SUPPORT = "examples/support-app/appbacktest.concurrent.yaml";
const SUPPORT_OUT = join(ROOT, "examples/support-app/.backtests");

check("two probes interleave on a seeded schedule", () => {
  rmSync(join(SUPPORT_OUT, "runs"), { recursive: true, force: true });
  const r = cli(["run", "--config", SUPPORT, "--seed", "606060"]);
  assert(r.code > 0, `expected the lost update to fail the run, exit ${r.code}`);
  const rep = freshReport(SUPPORT_OUT);
  const runDir = join(SUPPORT_OUT, "runs", rep.runs[0].runId);
  const rec = readJson(join(runDir, "record.json"));
  const actors = [...new Set(rec.steps.map((s) => s.actor).filter(Boolean))];
  assert(actors.length === 2, `expected 2 actors in the trace, got ${actors.join(",") || "none"}`);
  // Interleaved, not sequential: both actors act before either finishes.
  const seq = rec.steps.map((s) => s.actor);
  const firstA = seq.indexOf(actors[0]);
  const lastA = seq.lastIndexOf(actors[0]);
  const firstB = seq.indexOf(actors[1]);
  assert(firstB > firstA && firstB < lastA, "actors ran sequentially, not interleaved");
  return `${actors.join(" + ")} · ${rec.steps.length} interleaved steps`;
});

check("each user gets an isolated session (own browser context)", () => {
  const rep = freshReport(SUPPORT_OUT);
  const rec = readJson(join(SUPPORT_OUT, "runs", rep.runs[0].runId, "record.json"));
  // Both signed in independently; if they shared a context the second login
  // would have replaced the first and only one identity would appear.
  const typed = rec.steps.filter((s) => s.action.kind === "type").map((s) => s.action.text);
  assert(typed.includes("ana@meridian.test"), "ana never signed in");
  assert(typed.includes("ben@meridian.test"), "ben never signed in");
  assert(!typed.includes("support123"), "a password reached the trace unmasked");
  return "separate logins · passwords masked";
});

check("the lost update is caught as a critical discrepancy", () => {
  const rep = freshReport(SUPPORT_OUT);
  assert(rep.totals.discrepancies >= 1, "no discrepancy raised for the lost update");
  const critical = rep.findings.filter((f) => f.category === "critical_failure");
  assert(critical.length > 0, "lost update was not reported as a critical failure");
  const trail = critical[0].reproduction.join(" ");
  assert(/\[(ana|ben)\]/.test(trail), "reproduction does not attribute steps to actors");
  return `${critical.length} critical · reproduction names each actor`;
});

check("fixing the concurrency bug turns the run green", () => {
  const r = cli(["run", "--config", SUPPORT, "--seed", "606060"], { FIXED: "1" });
  assert(r.code === 0, `expected a clean pass with FIXED=1, exit ${r.code}\n${r.out.slice(-400)}`);
  const rep = freshReport(SUPPORT_OUT);
  assert(rep.totals.passed === 1 && rep.totals.discrepancies === 0, "control run was not clean");
  return "optimistic locking + retry → PASS";
});

// ---------------------------------------------------------------------------
group("Read-only source correlation");

check("source correlation attaches code locations without touching code", () => {
  const path = join(ROOT, "examples/expense-app/appbacktest.src.yaml");
  const base = readFileSync(join(ROOT, COVE), "utf8");
  writeFileSync(path, `${base}\nsource: { enabled: true, root: . }\n`);
  const before = readFileSync(join(ROOT, "examples/expense-app/public/form.js"), "utf8");
  try {
    cli(["report", "--config", "examples/expense-app/appbacktest.src.yaml"]);
    const rep = latestReport(COVE_OUT);
    const withRefs = rep.findings.filter((f) => f.codeRefs.length > 0);
    assert(withRefs.length > 0, "no code references produced");
    for (const f of withRefs) {
      for (const ref of f.codeRefs) {
        assert(ref.path && ref.why, "code ref missing path/why");
        assert(!ref.path.startsWith("/") && !/^[A-Za-z]:/.test(ref.path), "code ref path is absolute");
      }
    }
    const after = readFileSync(join(ROOT, "examples/expense-app/public/form.js"), "utf8");
    assert(before === after, "SOURCE FILE WAS MODIFIED — this must never happen");
    return `${withRefs.length} finding(s) with code refs · source byte-identical`;
  } finally {
    rmSync(path, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(`\n${"─".repeat(64)}`);
console.log(`\x1b[1mFeature verification\x1b[0m  ${passed}/${results.length} passed`);
if (failed.length > 0) {
  console.log(`\x1b[31m${failed.length} FAILED:\x1b[0m`);
  for (const f of failed) console.log(`  · ${f.group} → ${f.name}`);
}
console.log("─".repeat(64));
process.exit(failed.length > 0 ? 1 : 0);
