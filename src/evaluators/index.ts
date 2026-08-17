import type {
  AgentBelief,
  BrowserDriver,
  CheckConfig,
  CheckResult,
  Evaluation,
  FailureKind,
  Observation,
  RunEnding,
  TextCheck,
} from "../core/types";
import { getPath } from "./jsonpath";

/** Stringified `actual` values are truncated to this many characters (with "…"). */
const ACTUAL_MAX_CHARS = 300;

/** Poll re-evaluations of a failing (not errored) check, after the initial attempt. */
const MAX_POLLS = 8;

export interface RunChecksOptions {
  /**
   * Delay before the first evaluation. Cheap settle: the driver exposes no
   * waitForLoadState, so a fixed pause stands in for networkidle. Default 400.
   */
  settleMs?: number;
  /** Interval between polls of a failing check. Default 500 (8 polls ≈ 4s). */
  pollMs?: number;
  /** Every toast/aria-live message captured during the run (for `transient` checks). */
  transients?: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Whitespace-collapsed, lowercased — the normalization for all text matching. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Local stable stringify (sorted object keys) — deep-equality via string
// compare. Module-private on purpose: core/hash is a separate module and
// evaluators only need this one behavior.
function stableStringify(v: unknown): string {
  const s = JSON.stringify(v, (_key, val: unknown) =>
    val !== null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
  return s === undefined ? "undefined" : s;
}

function truncActual(v: unknown): string {
  const s = stableStringify(v);
  return s.length <= ACTUAL_MAX_CHARS ? s : s.slice(0, ACTUAL_MAX_CHARS - 1) + "…";
}

// Local URL resolution ("/api/x" + base → absolute). Module-private for the
// same reason as stableStringify.
function resolveCheckUrl(base: string, maybeRelative: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  try {
    return new URL(maybeRelative, base).toString();
  } catch (err) {
    throw new Error(
      `cannot resolve check url ${JSON.stringify(maybeRelative)} against app url ${JSON.stringify(base)}: ${(err as Error).message}`,
    );
  }
}

/**
 * v0.1 limitation: page checks always run on the page the agent ended on.
 * When check.at names a different page, we still evaluate but say so.
 */
function atNote(at: string | undefined, driver: BrowserDriver): string | undefined {
  if (!at) return undefined;
  const url = driver.currentUrl();
  if (url.includes(at)) return undefined;
  return `note: agent ended on ${url}, check.at=${at} — page checks run on the final page in v0.1`;
}

function joinDetail(...parts: Array<string | undefined>): string | undefined {
  const joined = parts.filter((p): p is string => Boolean(p)).join("; ");
  return joined === "" ? undefined : joined;
}

function evalUrl(
  check: Extract<CheckConfig, { type: "url" }>,
  driver: BrowserDriver,
): CheckResult {
  const url = driver.currentUrl();
  const passed = url.includes(check.contains);
  return {
    check,
    passed,
    errored: false,
    actual: url,
    detail: passed ? undefined : `url does not contain ${JSON.stringify(check.contains)}`,
  };
}

async function evalText(check: TextCheck, driver: BrowserDriver): Promise<CheckResult> {
  const text = norm(await driver.visibleText());
  const found = text.includes(norm(check.contains));
  const passed = check.type === "text" ? found : !found;
  const failDetail = passed
    ? undefined
    : check.type === "text"
      ? `text ${JSON.stringify(check.contains)} not found on page`
      : `text ${JSON.stringify(check.contains)} unexpectedly present`;
  return {
    check,
    passed,
    errored: false,
    detail: joinDetail(failDetail, atNote(check.at, driver)),
  };
}

async function evalElement(
  check: Extract<CheckConfig, { type: "element" | "no_element" }>,
  driver: BrowserDriver,
): Promise<CheckResult> {
  const perception = await driver.perceive();
  const wantName = norm(check.name);
  const matches = perception.elements.filter(
    (el) => el.role === check.role && norm(el.name).includes(wantName),
  );

  let passed: boolean;
  let failDetail: string | undefined;
  if (check.type === "element") {
    passed = matches.some((el) => !el.occluded);
    if (!passed) {
      failDetail =
        matches.length > 0
          ? `element found but occluded (${matches.length} match(es), all covered)`
          : `no ${check.role} matching ${JSON.stringify(check.name)} found`;
    }
  } else {
    passed = matches.length === 0;
    if (!passed) {
      failDetail = `found ${matches.length} ${check.role} element(s) matching ${JSON.stringify(check.name)}`;
    }
  }
  return {
    check,
    passed,
    errored: false,
    actual: matches.length,
    detail: joinDetail(failDetail, atNote(check.at, driver)),
  };
}

async function evalHttp(
  check: Extract<CheckConfig, { type: "http" }>,
  driver: BrowserDriver,
  appUrl: string,
): Promise<CheckResult> {
  const resolved = resolveCheckUrl(appUrl, check.url);
  let res: { status: number; body: string };
  try {
    res = await driver.contextGet(resolved);
  } catch (err) {
    return {
      check,
      passed: false,
      errored: true,
      detail: `GET ${resolved} failed: ${(err as Error).message}`,
    };
  }

  if (check.expectStatus !== undefined) {
    if (res.status !== check.expectStatus) {
      return {
        check,
        passed: false,
        errored: false,
        actual: res.status,
        detail: `expected status ${check.expectStatus}, got ${res.status}`,
      };
    }
  } else if (res.status < 200 || res.status >= 300) {
    // Without expectStatus a non-2xx means the check could not be evaluated.
    return { check, passed: false, errored: true, actual: res.status, detail: `HTTP ${res.status}` };
  }

  const hasBodyAssertion = check.count !== undefined || check.equals !== undefined;
  if (!hasBodyAssertion) {
    if (check.expectStatus !== undefined) {
      // Status was the whole assertion; body may not even be JSON.
      return { check, passed: true, errored: false, actual: res.status };
    }
    return {
      check,
      passed: false,
      errored: true,
      detail: "http check has no assertion field (need count, equals, or expectStatus)",
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    return {
      check,
      passed: false,
      errored: true,
      detail: `GET ${resolved}: response is not valid JSON`,
    };
  }

  const value = check.path !== undefined ? getPath(body, check.path) : body;
  if (value === undefined) {
    return {
      check,
      passed: false,
      errored: true,
      detail: `path not found: ${JSON.stringify(check.path)} (body: ${truncActual(body)})`,
    };
  }

  const failures: string[] = [];
  if (check.count !== undefined) {
    if (!Array.isArray(value)) {
      return {
        check,
        passed: false,
        errored: true,
        actual: truncActual(value),
        detail: `count requires an array at path, got ${value === null ? "null" : typeof value}`,
      };
    }
    if (value.length !== check.count) {
      failures.push(`expected count ${check.count}, got ${value.length}`);
    }
  }
  if (check.equals !== undefined) {
    if (stableStringify(value) !== stableStringify(check.equals)) {
      failures.push(`expected ${truncActual(check.equals)}`);
    }
  }
  return {
    check,
    passed: failures.length === 0,
    errored: false,
    actual: truncActual(value),
    detail: joinDetail(...failures),
  };
}

/**
 * `transient` asserts against the RECORDED trace, not the live DOM: toasts
 * auto-dismiss, and an agent's think-time before done() routinely outlives
 * them — asserting "the user was shown X" against the final page would race.
 * Pure data, never polls, can't error.
 */
function evalTransient(
  check: Extract<CheckConfig, { type: "transient" }>,
  transients: string[],
): CheckResult {
  const wanted = norm(check.contains);
  const passed = transients.some((t) => norm(t).includes(wanted));
  return {
    check,
    passed,
    errored: false,
    actual: transients.slice(0, 10),
    ...(passed ? {} : { detail: `no transient message contained "${check.contains}"` }),
  };
}

async function evaluateOnce(
  check: CheckConfig,
  driver: BrowserDriver,
  appUrl: string,
  transients: string[],
): Promise<CheckResult> {
  try {
    switch (check.type) {
      case "url":
        return evalUrl(check, driver);
      case "text":
      case "no_text":
        return await evalText(check, driver);
      case "transient":
        return evalTransient(check, transients);
      case "element":
      case "no_element":
        return await evalElement(check, driver);
      case "http":
        return await evalHttp(check, driver, appUrl);
    }
  } catch (err) {
    return {
      check,
      passed: false,
      errored: true,
      detail: `check could not be evaluated: ${(err as Error).message}`,
    };
  }
}

/**
 * Run all checks against the driver's current state. Settles first
 * (default 400ms), then evaluates each check in order; a failing (not
 * errored) check is re-polled up to MAX_POLLS (8) times at pollMs (default
 * 500ms ≈ 4s total) until it passes or errors. `attempts` records total
 * evaluations (1 = passed immediately, max 1 + MAX_POLLS = 9).
 */
export async function runChecks(
  checks: CheckConfig[],
  driver: BrowserDriver,
  appUrl: string,
  opts: RunChecksOptions = {},
): Promise<CheckResult[]> {
  const settleMs = opts.settleMs ?? 400;
  const pollMs = opts.pollMs ?? 500;
  const transients = opts.transients ?? [];
  if (settleMs > 0) await sleep(settleMs);

  const results: CheckResult[] = [];
  for (const check of checks) {
    let attempts = 1;
    let result = await evaluateOnce(check, driver, appUrl, transients);
    // transient checks are pure trace data — re-polling cannot change them
    while (!result.passed && !result.errored && check.type !== "transient" && attempts <= MAX_POLLS) {
      await sleep(pollMs);
      result = await evaluateOnce(check, driver, appUrl, transients);
      attempts += 1;
    }
    results.push({ ...result, attempts });
  }
  return results;
}

/**
 * Merge check results, ending, belief and observations into the final
 * verdict. Failure precedence: setup_failed > technical > check_error >
 * assertion. The agent's belief is recorded but never decides the verdict.
 * (`fatalError` is carried by the caller into the record; the verdict only
 * needs `ending === "fatal"`.)
 */
export function evaluate(args: {
  checkResults: CheckResult[];
  ending: RunEnding;
  belief: AgentBelief | null;
  observations: Observation[];
  setupFailed: boolean;
  fatalError?: string;
}): Evaluation {
  const { checkResults, ending, belief, observations, setupFailed } = args;

  let verdict: Evaluation["verdict"];
  let failureKind: FailureKind | undefined;
  if (setupFailed) {
    verdict = "SETUP_FAILED";
    failureKind = "setup_failed";
  } else if (ending === "fatal") {
    verdict = "FAIL";
    failureKind = "technical";
  } else if (checkResults.some((r) => r.errored)) {
    verdict = "FAIL";
    failureKind = "check_error";
  } else if (checkResults.some((r) => !r.passed)) {
    verdict = "FAIL";
    failureKind = "assertion";
  } else {
    verdict = "PASS";
  }

  return {
    verdict,
    ...(failureKind !== undefined ? { failureKind } : {}),
    ending,
    checkResults,
    agentBelief: belief,
    // Only a CLEAN assertion failure against a confident belief is a discrepancy.
    discrepancy: failureKind === "assertion" && belief?.outcome === "success",
    // Agent thought it failed / was unsure but the app actually worked.
    // A green run where the probe never actually finished is not a
    // pass worth trusting — it usually means the checks are too weak to be
    // measuring the workflow at all. `max_steps` leaves belief null, so it
    // has to be named explicitly or it slips through as a clean PASS.
    reverseDiscrepancy:
      verdict === "PASS" &&
      ((belief !== null && belief.outcome !== "success") || ending === "max_steps"),
    passedWithObservations:
      verdict === "PASS" && observations.some((o) => o.severity === "error"),
  };
}
