/**
 * AppBacktest — shared type contracts.
 *
 * This file is the single source of truth for every data shape that crosses a
 * module boundary. Modules depend on these types (and each other's public
 * factories) — never on each other's internals.
 *
 * Core philosophy encoded here:
 *   - The AGENT produces `AgentAction`s (behavior). It never sees selectors.
 *   - The FRAMEWORK produces `Perception`s, records `StepRecord`s, and issues
 *     the final `Evaluation`. The agent's belief is recorded but never trusted.
 *   - Everything strict replay consumes lives INSIDE the `RunRecord`. The
 *     seed is provenance; replay never re-derives anything from it.
 */

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/**
 * Deterministic PRNG. Implemented in core/rng.ts (xmur3 label-path hashing +
 * mulberry32 streams).
 */
export interface RngLike {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Pick one element. Throws on empty array. */
  pick<T>(arr: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
  /**
   * Independent child stream. MUST be a pure function of the label path
   * (hash(parentLabelPath + ":" + label)) — never derived by consuming parent
   * draws — so adding a fork or drawing from one stream can never reshuffle
   * any sibling stream for the same seed.
   */
  fork(label: string): RngLike;
  /** The full label path of this stream (for tests/debugging). */
  readonly labelPath: string;
}

// ---------------------------------------------------------------------------
// Configuration (shape AFTER zod validation + defaults)
// ---------------------------------------------------------------------------

export type DeviceKind = "desktop" | "mobile";
export type PatienceLevel = "low" | "normal" | "high";

export interface PersonaConfig {
  device?: DeviceKind;
  /** low=12 / normal=20 / high=30 max steps. */
  patience?: PatienceLevel;
  /** Probability [0,1] the executor dispatches a click twice (same-task double dispatch). */
  doubleClickChance?: number;
  /** Size of generated upload files in KB. */
  uploadSizeKB?: number;
  /** Free-text traits passed verbatim to the agent prompt (steers intent). */
  traits?: string[];
}

/**
 * Deterministic checks. All evaluator HTTP traffic is GET-only and issued
 * through the browser context's request client (cookies/session flow), so
 * checks see the app as the logged-in user does.
 */
export type CheckConfig =
  | { type: "url"; contains: string }
  | { type: "text"; contains: string }
  | { type: "no_text"; contains: string }
  | {
      /**
       * Asserts the user was SHOWN a transient message (toast / aria-live)
       * at some point during the run. `text` checks race auto-dismissing
       * toasts — an agent's think-time before done() outlives them — so
       * transient feedback is asserted against the recorded trace instead.
       */
      type: "transient";
      contains: string;
    }
  | { type: "element"; role: string; name: string; at?: string }
  | { type: "no_element"; role: string; name: string; at?: string }
  | {
      /**
       * State assertion against an app endpoint. `url` may be relative to
       * app.url. `path` is a dot-path into the JSON body ("loads.0.pods").
       * `count` asserts array length at path; `equals` asserts strict deep
       * equality at path; `expectStatus` asserts the HTTP status (default:
       * any 2xx). At least one assertion field is required.
       */
      type: "http";
      url: string;
      path?: string;
      count?: number;
      equals?: unknown;
      expectStatus?: number;
    };

/** `text`/`no_text` also accept `at` (navigate there before evaluating). */
export type TextCheck = Extract<CheckConfig, { type: "text" | "no_text" }> & {
  at?: string;
};

/** One participant in a concurrent scenario. */
export interface ConcurrentActorConfig {
  /** Stable name used in the trace and report ("dispatcher", "driver"). */
  name: string;
  persona: string | PersonaConfig;
  goal: string;
}

export interface ScenarioConfig {
  /** Persona key (from `personas`) or an inline persona object. Single-actor scenarios. */
  persona?: string | PersonaConfig;
  goal?: string;
  /**
   * Multi-user scenario: several simulated people work the app at the same
   * time, each in their own browser context (own session and cookies). Turns
   * are interleaved on a seeded schedule, so the interleaving is reproducible
   * — which is what makes lost updates and stale-view bugs replayable.
   */
  concurrent?: ConcurrentActorConfig[];
  checks: CheckConfig[];
}

export interface HttpHookConfig {
  method: "GET" | "POST";
  url: string; // may be relative to app.url
}

export interface AppConfig {
  name: string;
  url: string;
  /**
   * Optional command to start the app (mirrors Playwright's webServer).
   * AppBacktest starts it, polls `url` until ready, kills it on exit.
   */
  command?: string;
  /**
   * Called before each run/replay to reset app state. Part of the determinism
   * contract for stateful apps: without it, http count/equals checks
   * self-poison across runs (the CLI warns loudly in that case).
   */
  resetHook?: HttpHookConfig;
}

export type ProviderConfig =
  | {
      type: "anthropic";
      /** Anthropic model id. Default: claude-opus-5. */
      model?: string;
      /**
       * Reasoning effort for decision calls. Default: "low" — a simulated user
       * picking their next click is not a reasoning-heavy task, and effort is
       * the main cost lever in a run.
       */
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
    }
  | {
      /**
       * Any /v1/chat/completions endpoint: NVIDIA NIM, OpenAI, Ollama, vLLM.
       * Prompted vocabulary + hardened JSON extraction; zod is still the gate.
       */
      type: "openai_compatible";
      baseUrl: string;
      model: string;
      /** Env var holding the bearer token. Omit for keyless endpoints. */
      apiKeyEnv?: string;
      temperature?: number;
      maxTokens?: number;
    }
  | {
      /** Fixture-driven decisions from a JSON file — zero API keys, fully deterministic. */
      type: "fixture";
      path: string;
    };

export interface BrowserConfig {
  headless: boolean;
  /** Per-action timeout in ms. */
  actionTimeoutMs: number;
  /** Watch mode (CLI `--watch`): visible browser, slowed down, cursor + HUD. */
  watch?: boolean;
}

export interface ObserverConfig {
  /** Regex sources; console messages matching any are ignored. */
  ignoreConsole: string[];
  /** URL substrings; failed/HTTP-error requests matching any are ignored. */
  ignoreRequests: string[];
}

export interface AppBacktestConfig {
  app: AppConfig;
  provider: ProviderConfig;
  personas: Record<string, PersonaConfig>;
  scenarios: Record<string, ScenarioConfig>;
  /** Runs per scenario. Each gets sub-seed `${seed}:${scenarioKey}:${i}`. */
  runs: number;
  browser: BrowserConfig;
  observers: ObserverConfig;
  redaction: RedactionConfig;
  ux: UxConfig;
  source: SourceConfig;
  replay: ReplayConfig;
  /** Artifact root, default ".backtests". */
  outDir: string;
}

// ---------------------------------------------------------------------------
// World plan (seed → deterministic plan)
// ---------------------------------------------------------------------------

export interface ResolvedPersona {
  device: DeviceKind;
  patience: PatienceLevel;
  maxSteps: number;
  doubleClickChance: number;
  uploadSizeKB: number;
  traits: string[];
}

/** A resolved participant of a concurrent run. */
export interface ResolvedActor {
  name: string;
  personaKey: string;
  goal: string;
  persona: ResolvedPersona;
}

export interface RunPlan {
  runId: string;
  /** `${seed}:${scenarioKey}:${runIndex}` — stable identity, not position. */
  subSeed: string;
  scenarioKey: string;
  personaKey: string;
  goal: string;
  persona: ResolvedPersona;
  checks: CheckConfig[];
  /** Present for multi-user scenarios; the fields above describe actor 0. */
  actors?: ResolvedActor[];
}

export interface WorldPlan {
  seed: string;
  runs: RunPlan[];
}

// ---------------------------------------------------------------------------
// Perception — what the agent is allowed to see
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
}

export interface PerceivedElement {
  /** Ephemeral ref ("e1", frame-scoped "f1:e3") valid until the next perception. */
  ref: string;
  /** link | button | textbox | checkbox | radio | select | file | textbox(contenteditable) | generic. */
  role: string;
  /** Accessible name: aria-label || aria-labelledby || label[for]/ancestor label || text || placeholder || title || img alt. */
  name: string;
  value?: string;
  disabled?: boolean;
  /** Another element covers this one's center point (e.g. a modal is open). */
  occluded?: boolean;
  /**
   * Toggle state from aria-pressed / aria-selected / aria-checked (or a
   * checkbox's own checked). Without this, a chosen option is indistinguishable
   * from an unchosen one and agents re-click controls that already worked.
   */
  selected?: boolean;
  /** Present on selects: legal options (capped at 20). */
  options?: SelectOption[];
  /**
   * Password field, or a name matching the redaction patterns. Text typed
   * into it is masked before it ever reaches the trace.
   */
  sensitive?: boolean;
  /** Index among same (role, name) elements — last-resort disambiguation. */
  nth: number;
}

export interface Perception {
  url: string;
  title: string;
  /** Visible text, main-content-first, whitespace-collapsed, truncated (≤ ~1500 chars, marked when truncated). */
  textDigest: string;
  /** Interactive elements: attached and not hidden (NOT viewport-filtered). Capped at 80. */
  elements: PerceivedElement[];
  /** Set when a modal dialog is open (its accessible name). */
  modalOpen?: string;
}

/**
 * Stable target descriptor stored in the trace. Strict replay re-resolves it;
 * resolution failure or identity mismatch ⇒ DIVERGED, never a wrong click.
 */
export interface ResilientLocator {
  role: string;
  name: string;
  nth: number;
  /** Present for elements inside iframes. */
  frameUrl?: string;
}

// ---------------------------------------------------------------------------
// Actions — the closed vocabulary (schema-enforced at the provider boundary)
// ---------------------------------------------------------------------------

export type PressableKey = "Escape" | "Enter" | "Tab" | "ArrowDown" | "ArrowUp";

export type AgentAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; pressEnter?: boolean }
  | { kind: "select"; ref: string; value: string }
  | { kind: "upload"; ref: string }
  | { kind: "press"; key: PressableKey }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "back" }
  | { kind: "wait"; ms: number } // capped at 2000 by the executor
  | { kind: "done"; outcome: "success" | "unsure"; summary: string }
  | { kind: "give_up"; reason: string };

// ---------------------------------------------------------------------------
// Trace — what actually happened (the replay substrate)
// ---------------------------------------------------------------------------

export interface PerturbationEvent {
  /** double_click = second dispatch in the same task, no await between. */
  kind: "double_click";
  detail?: string;
}

export interface DialogEvent {
  dialogType: string; // alert | confirm | prompt | beforeunload
  message: string;
  response: "accept" | "dismiss";
  atMs?: number;
}

export interface ConsoleEntry {
  level: "log" | "warning" | "error";
  text: string;
  /** Epoch ms when observed — powers the replay timeline. */
  atMs?: number;
}

export interface NetworkEntry {
  method: string;
  url: string;
  /** HTTP status, or -1 for a failed/aborted request. */
  status: number;
  atMs?: number;
}

/** A toast / aria-live message with the moment it appeared. */
export interface TransientEvent {
  text: string;
  atMs: number;
}

/** Everything that surfaced between the previous drain and now. */
export interface IncidentDrain {
  consoleDelta: ConsoleEntry[];
  networkDelta: NetworkEntry[];
  /** aria-live / role=alert|status additions (toasts, inline errors). */
  transientMessages: string[];
  /** Same messages with timestamps, for the replay timeline. */
  transientEvents?: TransientEvent[];
  dialogs: DialogEvent[];
  /** True if a popup/new tab was adopted as the active page. */
  tabSwitched: boolean;
}

export type StepErrorKind =
  | "stale_target" // node identity changed between perceive and act — NOT clicked
  | "not_found"
  | "timeout"
  | "navigation_error"
  | "invalid_action";

export interface StepResult {
  ok: boolean;
  error?: string;
  errorKind?: StepErrorKind;
  urlAfter: string;
}

export interface StepRecord {
  index: number;
  /** Which simulated person took this step (multi-user runs only). */
  actor?: string;
  /** ms since the previous step's action finished (replay readiness gate input). */
  elapsedMs: number;
  preUrl: string;
  /** Stable hash of the pre-action perception (url + element descriptors). */
  perceptionDigest: string;
  perception: {
    title: string;
    elementCount: number;
    /** Accessible name of an open modal, when one was showing. */
    modalOpen?: string;
  };
  action: AgentAction;
  /** Captured AT DISPATCH TIME for element-targeted actions. */
  target?: ResilientLocator;
  perturbations: PerturbationEvent[];
  incidents: IncidentDrain;
  result: StepResult;
  /**
   * The page as the simulated user SAW it, before deciding. POSIX-style path
   * relative to the run directory.
   */
  screenshot?: string;
  /**
   * The page just after the action, with the drawn cursor still resting on the
   * control that was hit. This is the frame that shows WHERE the user clicked;
   * the pre-action shot cannot, because the target is not chosen yet.
   */
  screenshotAfter?: string;
  tsStart: string;
  tsEnd: string;
}

// ---------------------------------------------------------------------------
// Observations — framework-detected signals (independent of the agent)
// ---------------------------------------------------------------------------

export type ObservationKind =
  | "console_error"
  | "page_error"
  | "request_failed"
  | "http_error"
  | "action_error"
  | "dialog_auto_handled"
  | "gave_up"
  | "max_steps";

export type Severity = "info" | "warning" | "error";

export interface Observation {
  kind: ObservationKind;
  severity: Severity;
  message: string;
  stepIndex?: number;
}

// ---------------------------------------------------------------------------
// Evaluation — deterministic verdict (never the agent's opinion)
// ---------------------------------------------------------------------------

export interface CheckResult {
  check: CheckConfig;
  passed: boolean;
  /** True when the check could not be EVALUATED (endpoint down, bad path…) — distinct from evaluating false. */
  errored: boolean;
  actual?: unknown;
  detail?: string;
  /** Poll attempts before settling (evaluators poll failing checks up to ~4s). */
  attempts?: number;
}

/** setup_failed > technical > check_error > assertion (precedence). */
export type FailureKind = "setup_failed" | "technical" | "check_error" | "assertion";

/** How the agent phase ended — recorded independently of the verdict. */
export type RunEnding = "done" | "gave_up" | "max_steps" | "fatal";

export interface AgentBelief {
  /** Structural, schema-enforced — never parsed from prose. give_up ⇒ "failure". */
  outcome: "success" | "unsure" | "failure";
  summary: string;
}

export interface Evaluation {
  /** SETUP_FAILED runs are quarantined: never counted as pass/fail, never promotable. */
  verdict: "PASS" | "FAIL" | "SETUP_FAILED";
  failureKind?: FailureKind;
  ending: RunEnding;
  checkResults: CheckResult[];
  agentBelief: AgentBelief | null;
  /** belief=success AND failureKind=assertion (checks executed cleanly and failed). */
  discrepancy: boolean;
  /** Agent gave up / unsure but checks pass — a UX finding, surfaced not discarded. */
  reverseDiscrepancy: boolean;
  /** PASS that carried error-severity observations (surfaced in every report). */
  passedWithObservations: boolean;
}

// ---------------------------------------------------------------------------
// RunRecord — one simulated user's complete, self-contained, replayable history
// ---------------------------------------------------------------------------

export type ReplayOutcome = "REPRODUCED" | "FIXED" | "DIVERGED" | "INCONCLUSIVE";

export interface UploadArtifact {
  sizeKB: number;
  sha256: string;
  generatorVersion: number;
}

export interface RunRecord {
  formatVersion: 1;
  appbacktestVersion: string;
  runId: string;
  /** Provenance only — replay consumes the record, never re-derives from seed. */
  seed: string;
  subSeed: string;
  scenarioKey: string;
  personaKey: string;
  goal: string;
  world: { persona: ResolvedPersona };
  provider: { type: string; model?: string; usage?: ProviderUsage };
  app: { name: string; url: string };
  /** sha256 of normalized config+checks — tamper-EVIDENCE (see DESIGN.md §trust). */
  configHash: string;
  /** The checks, frozen verbatim (promoted fixtures grade against THESE). */
  checks: CheckConfig[];
  upload?: UploadArtifact;
  startedAt: string;
  finishedAt: string;
  steps: StepRecord[];
  observations: Observation[];
  evaluation: Evaluation;
  replayOf?: string;
  replayOutcome?: ReplayOutcome;
  /** First step where strict replay diverged + why (when DIVERGED). */
  divergence?: { stepIndex: number; reason: string };
}

// ---------------------------------------------------------------------------
// Timeline & replay evidence
//
// The timeline is DERIVED from a RunRecord — actions the simulated user took
// interleaved with events the application produced, on one clock. It is what
// a human scrubs through when answering "show me exactly what happened".
// ---------------------------------------------------------------------------

export type TimelineKind =
  | "action"
  | "navigation"
  | "console"
  | "network"
  | "transient"
  | "dialog"
  | "error"
  | "finding";

export interface TimelineEntry {
  /** Milliseconds since the session started. */
  atMs: number;
  kind: TimelineKind;
  /** Step this belongs to, when applicable. */
  stepIndex?: number;
  label: string;
  detail?: string;
  severity?: Severity;
  /** POSIX path relative to the run directory. */
  screenshot?: string;
}

/**
 * A window of timeline around a finding — the "failure clip". Screenshots are
 * referenced, never copied, so evidence stays cheap; the window is
 * configurable via `replay.beforeMs` / `replay.afterMs`.
 */
export interface ReplayClip {
  runId: string;
  runDir: string;
  startMs: number;
  focusMs: number;
  endMs: number;
  entries: TimelineEntry[];
}

// ---------------------------------------------------------------------------
// Findings — AppBacktest's interpretation of the evidence
//
// Deliberately separate from Evaluation (pass/fail of the configured checks).
// A finding carries category, severity, confidence, reproduction, evidence and
// a replay clip, and groups repeat occurrences instead of duplicating.
// ---------------------------------------------------------------------------

export type FindingCategory =
  | "critical_failure"
  | "functional_bug"
  | "visual_bug"
  | "performance"
  | "usability"
  | "qol_recommendation";

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

/** A read-only pointer into the user's source. AppBacktest never writes here. */
export interface CodeRef {
  /** POSIX path relative to the source root. */
  path: string;
  line?: number;
  snippet?: string;
  /** Why this location is implicated by the runtime evidence. */
  why: string;
}

export interface FindingOccurrence {
  runId: string;
  runDir: string;
  scenarioKey: string;
  personaKey: string;
  atMs?: number;
  clip?: ReplayClip;
}

export interface Finding {
  /** Stable across runs — repeat sightings group onto one finding. */
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  /** 0-1. Rises with reproduction count. */
  confidence: number;
  title: string;
  /** What AppBacktest saw. Always grounded in captured evidence. */
  observed: string;
  expected?: string;
  /** Usability / QoL only. */
  userImpact?: string;
  suggestion?: string;
  /** The action trail that produced it. */
  reproduction: string[];
  /** Verbatim evidence lines (network, console, checks). */
  evidence: string[];
  occurrences: FindingOccurrence[];
  /** e.g. "7 / 20 attempts". */
  reproducedIn: string;
  codeRefs: CodeRef[];
  /** Invariant of the product: AppBacktest is diagnostic, never a fixer. */
  sourceModified: false;
}

// ---------------------------------------------------------------------------
// Feature configuration (recording / UX / source correlation)
// ---------------------------------------------------------------------------

/**
 * Sensitive values are masked AT CAPTURE — preventing recording beats
 * scrubbing afterwards.
 */
export interface RedactionConfig {
  enabled: boolean;
  /** Regex sources matched against an element's accessible name/role. */
  fieldPatterns: string[];
  /** Regex sources matched against captured text and URLs. */
  valuePatterns: string[];
  mask: string;
}

export type UxLevel = "off" | "conservative" | "balanced" | "detailed";

export interface UxConfig {
  /** Default "conservative": few, high-confidence, evidence-backed only. */
  level: UxLevel;
  minConfidence: number;
  maxRecommendations: number;
}

export interface SourceConfig {
  /** Read-only correlation. Disabled unless a root is configured. */
  enabled: boolean;
  root?: string;
  maxFiles: number;
}

export interface ReplayConfig {
  /** Clip window around a finding. */
  beforeMs: number;
  afterMs: number;
}

// ---------------------------------------------------------------------------
// Provider — the agent brain boundary
// ---------------------------------------------------------------------------

/**
 * History entries are COMPACT one-liners (context-growth contract): the full
 * perception is sent for the current step only.
 */
export interface HistoryEntry {
  index: number;
  action: AgentAction;
  ok: boolean;
  error?: string;
  urlAfter: string;
  /** Toasts/dialog text the user would have seen after this action. */
  feedback?: string[];
}

export interface DecideContext {
  goal: string;
  /** Which simulated person is deciding (multi-user runs only). */
  actorName?: string;
  persona: ResolvedPersona;
  appUrl: string;
  stepIndex: number;
  maxSteps: number;
  history: HistoryEntry[];
  perception: Perception;
}

/**
 * Token accounting for paid providers. Deliberately raw counts, never dollars:
 * prices change and vary by model, so the record stays true forever and the
 * reporter does the arithmetic at display time.
 */
export interface ProviderUsage {
  /** Billable decision calls, including corrective retries. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Cached-read input, billed at a discount. Subset of inputTokens' cost basis. */
  cacheReadTokens?: number;
}

export interface AgentProvider {
  readonly name: string;
  decide(ctx: DecideContext): Promise<AgentAction>;
  /**
   * Cumulative usage so far, if the provider meters it. Read after a run;
   * providers that cost nothing (fixture) simply omit this.
   */
  readonly usage?: ProviderUsage;
}

// ---------------------------------------------------------------------------
// Browser driver — the executor boundary
// ---------------------------------------------------------------------------

export interface DriverOptions {
  appUrl: string;
  headless: boolean;
  device: DeviceKind;
  actionTimeoutMs: number;
  /**
   * Watch mode: slow the run down and draw a cursor + HUD so a human can see
   * what the simulated user is doing. Presentation only — the overlay is
   * excluded from perception and cannot intercept pointer events.
   */
  watch?: boolean;
  /** Shown in the watch HUD. */
  goal?: string;
  /** Masks sensitive values as evidence is captured. */
  redactor?: import("./redaction").Redactor;
  /** Absolute dir where the driver may write generated upload files. */
  workDir: string;
  /** Upload profile for filechooser interception. */
  uploadSizeKB: number;
  /** Sub-seed for deterministic upload-file generation. */
  uploadSeed: string;
}

export interface ActOutcome {
  ok: boolean;
  error?: string;
  errorKind?: StepErrorKind;
  urlAfter: string;
  perturbations: PerturbationEvent[];
  /** Descriptor of the node actually dispatched to (act-time identity). */
  resolvedTarget?: ResilientLocator;
  /**
   * Set when the action's text was typed into a sensitive field: the engine
   * records THIS instead of the real value.
   */
  redactedText?: string;
}

export interface ActOptions {
  persona: ResolvedPersona;
  /** Stream dedicated to this run's perturbation rolls. */
  rng: RngLike;
  /** Strict replay: apply exactly these, roll nothing. */
  forcedPerturbations?: PerturbationEvent[];
}

export interface BrowserDriver {
  start(): Promise<void>;
  /** Fresh multi-frame DOM walk (attached + not hidden; occlusion flagged). */
  perceive(): Promise<Perception>;
  /** Resolve a ref from the LAST perception into a stable descriptor. */
  describeRef(ref: string): ResilientLocator | undefined;
  /** Strict replay: find the current ref matching a recorded descriptor. Fresh walk. */
  resolveLocator(locator: ResilientLocator): Promise<string | undefined>;
  /**
   * Execute one action. Element-targeted actions MUST re-verify the tagged
   * node still matches its perceive-time {role,name} before dispatch; a
   * mismatch fails the step with errorKind "stale_target" (never a wrong click).
   */
  act(action: AgentAction, opts: ActOptions): Promise<ActOutcome>;
  screenshot(absPath: string): Promise<void>;
  /** Incidents accumulated since the last drain (console, network, toasts, dialogs, tab switches). */
  drainIncidents(): IncidentDrain;
  visibleText(): Promise<string>;
  currentUrl(): string;
  /** GET through the browser context's request client (cookies flow) — evaluators use this. */
  contextGet(url: string): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Engine events (streaming CLI output)
// ---------------------------------------------------------------------------

export interface EngineEvents {
  onRunStart?(plan: RunPlan): void;
  onStep?(step: StepRecord): void;
  onRunEnd?(record: RunRecord): void;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface RunSummary {
  runId: string;
  scenarioKey: string;
  personaKey: string;
  subSeed: string;
  verdict: "PASS" | "FAIL" | "SETUP_FAILED";
  failureKind?: FailureKind;
  ending: RunEnding;
  discrepancy: boolean;
  reverseDiscrepancy: boolean;
  passedWithObservations: boolean;
  steps: number;
  durationMs: number;
  observationCounts: Partial<Record<ObservationKind, number>>;
  /** POSIX path relative to outDir. */
  runDir: string;
}

/**
 * No composite score in v0.1 (deliberate): components are reported unbundled —
 * a single number invites Goodharting and hides variance at small N.
 */
export interface BacktestReport {
  formatVersion: 1;
  appbacktestVersion: string;
  app: { name: string; url: string };
  seed: string;
  configHash: string;
  /** Check definitions verbatim — evaluator edits are visible in PR diffs. */
  checksByScenario: Record<string, CheckConfig[]>;
  startedAt: string;
  finishedAt: string;
  runs: RunSummary[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    setupFailed: number;
    discrepancies: number;
    reverseDiscrepancies: number;
    passedWithObservations: number;
    byFailureKind: Partial<Record<FailureKind, number>>;
    /** Actions the simulated users performed across the session. */
    actions: number;
    /** What the session cost in tokens. Absent when no provider bills. */
    usage?: ProviderUsage;
  };
  /** Categorised interpretation of the evidence — problems first. */
  findings: Finding[];
  findingCounts: Record<FindingCategory, number>;
}
