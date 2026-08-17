/**
 * PlaywrightDriver — the executor. Perceives via the in-page walker, dispatches
 * the closed action vocabulary, injects seeded perturbations, and captures
 * incidents (console, network, toasts, dialogs, popups).
 *
 * Trust rule enforced here: an element-targeted action NEVER dispatches to a
 * node whose current {role, name} no longer matches the descriptor captured
 * at perception time — that fails typed as "stale_target" instead of clicking
 * the wrong thing (a silent harness misclick would poison discrepancy data).
 */

import { chromium } from "playwright";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActOptions,
  ActOutcome,
  AgentAction,
  BrowserDriver,
  ConsoleEntry,
  DialogEvent,
  DriverOptions,
  IncidentDrain,
  NetworkEntry,
  Perception,
  PerturbationEvent,
  ResilientLocator,
  StepErrorKind,
  TransientEvent,
} from "../core/types";
import {
  FILE_INPUT_SOURCE,
  IDENTITY_SOURCE,
  TRANSIENT_OBSERVER_SOURCE,
  WALKER_SOURCE,
  WATCH_OVERLAY_SOURCE,
  WATCH_UPDATE_SOURCE,
} from "./perception";
import { generateUploadPng } from "./uploads";
import { Redactor } from "../core/redaction";

const WAIT_CAP_MS = 2000;
/** Watch mode pacing: slow every Playwright op, and let the cursor glide land. */
const WATCH_SLOW_MO_MS = 220;
const WATCH_CURSOR_SETTLE_MS = 520;

const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

function nameMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

interface RefInfo {
  frameIndex: number;
  desc: ResilientLocator;
}

interface WalkedElement {
  ref: string;
  role: string;
  name: string;
  nth: number;
  value?: string;
  disabled?: boolean;
  occluded?: boolean;
  selected?: boolean;
  sensitive?: boolean;
  options?: Array<{ value: string; label: string }>;
}

interface WalkResult {
  url: string;
  title: string;
  textDigest: string;
  modalOpen?: string;
  elements: WalkedElement[];
}

class PlaywrightDriver implements BrowserDriver {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private refMap = new Map<string, RefInfo>();
  private uploadPath = "";

  private consoleBuf: ConsoleEntry[] = [];
  private networkBuf: NetworkEntry[] = [];
  private transientBuf: string[] = [];
  private transientEventBuf: TransientEvent[] = [];
  private dialogBuf: DialogEvent[] = [];
  private tabSwitched = false;
  /** context.on("page") fires for our own first page too — never wire twice. */
  private wired = new WeakSet<Page>();
  /** Actions dispatched so far — shown in the watch HUD. */
  private actCount = 0;

  /** Applied as evidence is captured — secrets never reach the trace. */
  private readonly redactor: Redactor;

  constructor(private opts: DriverOptions) {
    this.redactor =
      opts.redactor ??
      new Redactor({ enabled: false, fieldPatterns: [], valuePatterns: [], mask: "[redacted]" });
  }

  async start(): Promise<void> {
    mkdirSync(this.opts.workDir, { recursive: true });
    this.uploadPath = join(this.opts.workDir, "upload.png");
    writeFileSync(
      this.uploadPath,
      generateUploadPng(this.opts.uploadSeed, this.opts.uploadSizeKB),
    );

    this.browser = await chromium.launch({
      headless: this.opts.headless,
      ...(this.opts.watch ? { slowMo: WATCH_SLOW_MO_MS } : {}),
    });
    this.context = await this.browser.newContext(
      this.opts.device === "mobile"
        ? {
            viewport: { width: 390, height: 844 },
            userAgent:
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            hasTouch: true,
            isMobile: true,
          }
        : { viewport: { width: 1280, height: 800 } },
    );
    // Bind BEFORE the init script so in-page toasts reach Node the instant
    // they fire — a document that navigates away takes its DOM with it.
    await this.context.exposeFunction("__abtPushTransient", (text: string) => {
      if (typeof text === "string" && text.length > 0) {
        const safe = this.redactor.text(text.slice(0, 300));
        this.transientBuf.push(safe);
        this.transientEventBuf.push({ text: safe, atMs: Date.now() });
      }
    });
    await this.context.addInitScript(TRANSIENT_OBSERVER_SOURCE);
    if (this.opts.watch) {
      await this.context.addInitScript(
        `window.__abt_hud_goal = ${JSON.stringify(this.opts.goal ?? "")};`,
      );
      await this.context.addInitScript(WATCH_OVERLAY_SOURCE);
    }

    this.page = await this.context.newPage();
    this.wirePage(this.page);

    this.context.on("page", (newPage) => {
      if (this.wired.has(newPage)) return; // our own page, already wired
      // A popup / new tab: adopt it as active so the agent isn't stranded.
      this.page = newPage;
      this.wirePage(newPage);
      this.tabSwitched = true;
      newPage.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
    });
    await this.page.goto(this.opts.appUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(this.opts.actionTimeoutMs, 10_000),
    });
  }

  private wirePage(page: Page): void {
    if (this.wired.has(page)) return;
    this.wired.add(page);
    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning") {
        this.consoleBuf.push({
          level: type === "error" ? "error" : "warning",
          text: this.redactor.text(msg.text().slice(0, 400)),
          atMs: Date.now(),
        });
      }
    });
    page.on("pageerror", (err) => {
      this.consoleBuf.push({
        level: "error",
        text: this.redactor.text(`pageerror: ${String(err.message ?? err).slice(0, 400)}`),
        atMs: Date.now(),
      });
    });
    page.on("requestfailed", (req) => {
      const failure = req.failure()?.errorText ?? "";
      if (failure.includes("ERR_ABORTED")) return; // navigation-cancelled noise
      this.networkBuf.push({
        method: req.method(),
        url: this.redactor.url(req.url()),
        status: -1,
        atMs: Date.now(),
      });
    });
    page.on("response", (res) => {
      if (res.status() >= 400) {
        this.networkBuf.push({
          method: res.request().method(),
          url: this.redactor.url(res.url()),
          status: res.status(),
          atMs: Date.now(),
        });
      }
    });
    page.on("dialog", (dialog) => {
      const accept = dialog.type() !== "beforeunload";
      this.dialogBuf.push({
        dialogType: dialog.type(),
        message: this.redactor.text(dialog.message().slice(0, 300)),
        response: accept ? "accept" : "dismiss",
        atMs: Date.now(),
      });
      (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    page.on("filechooser", (chooser) => {
      chooser
        .setFiles(this.uploadPath)
        .then(() => this.transientBuf.push("file chosen: upload.png"))
        .catch(() => {});
    });
  }

  private mustPage(): Page {
    if (!this.page) throw new Error("driver not started");
    return this.page;
  }

  private frameForRef(ref: string): Frame {
    const page = this.mustPage();
    const info = this.refMap.get(ref);
    const frames = page.frames();
    if (info && info.frameIndex < frames.length) return frames[info.frameIndex]!;
    return page.mainFrame();
  }

  async perceive(): Promise<Perception> {
    const page = this.mustPage();
    await this.harvestTransients();
    this.refMap.clear();

    const frames = page.frames();
    let main: WalkResult | undefined;
    const elements: Perception["elements"] = [];

    for (let i = 0; i < frames.length && elements.length < 80; i++) {
      const frame = frames[i]!;
      let walked: WalkResult;
      try {
        walked = (await frame.evaluate(`${WALKER_SOURCE}(${JSON.stringify(`f${i}`)})`)) as WalkResult;
      } catch {
        continue; // detached / cross-origin-restricted frame
      }
      if (i === 0) main = walked;
      const frameUrl = i === 0 ? undefined : frame.url();
      for (const el of walked.elements) {
        if (elements.length >= 80) break;
        const desc: ResilientLocator = { role: el.role, name: el.name, nth: el.nth };
        if (frameUrl) desc.frameUrl = frameUrl;
        this.refMap.set(el.ref, { frameIndex: i, desc });
        elements.push({
          ref: el.ref,
          role: el.role,
          name: el.name,
          nth: el.nth,
          ...(el.value !== undefined ? { value: el.value } : {}),
          ...(el.disabled ? { disabled: true } : {}),
          ...(el.occluded ? { occluded: true } : {}),
          ...(el.selected !== undefined ? { selected: el.selected } : {}),
          ...(el.sensitive ? { sensitive: true } : {}),
          ...(el.options ? { options: el.options } : {}),
        });
      }
    }

    return {
      url: main?.url ?? page.url(),
      title: main?.title ?? "",
      textDigest: main?.textDigest ?? "",
      ...(main?.modalOpen ? { modalOpen: main.modalOpen } : {}),
      elements,
    };
  }

  describeRef(ref: string): ResilientLocator | undefined {
    return this.refMap.get(ref)?.desc;
  }

  async resolveLocator(locator: ResilientLocator): Promise<string | undefined> {
    await this.perceive(); // fresh walk re-stamps refs and refills refMap
    const candidates: Array<{ ref: string; desc: ResilientLocator }> = [];
    for (const [ref, info] of this.refMap) {
      if (info.desc.role !== locator.role) continue;
      if (!nameMatch(info.desc.name, locator.name)) continue;
      if (locator.frameUrl && info.desc.frameUrl !== locator.frameUrl) continue;
      candidates.push({ ref, desc: info.desc });
    }
    if (candidates.length === 0) return undefined;
    const exact = candidates.filter((c) => norm(c.desc.name) === norm(locator.name));
    const pool = exact.length > 0 ? exact : candidates;
    const byNth = pool.find((c) => c.desc.nth === locator.nth);
    return (byNth ?? pool[0]!).ref;
  }

  async act(action: AgentAction, opts: ActOptions): Promise<ActOutcome> {
    const page = this.mustPage();
    const urlBefore = page.url();
    this.actCount += 1;
    const perturbations: PerturbationEvent[] = [];
    const fail = (errorKind: StepErrorKind, error: string): ActOutcome => ({
      ok: false,
      error,
      errorKind,
      urlAfter: page.url(),
      perturbations,
    });

    try {
      let resolvedTarget: ResilientLocator | undefined;
      /** Set when the typed value must not be written to the trace. */
      let redactedText: string | undefined;

      if (
        action.kind === "click" ||
        action.kind === "type" ||
        action.kind === "select" ||
        action.kind === "upload"
      ) {
        let ref = action.ref;
        let stored = this.refMap.get(ref)?.desc;
        if (!stored) {
          return fail("not_found", `unknown ref "${ref}" — refs are only valid for the latest perception`);
        }

        // Identity re-verification at dispatch time.
        let frame = this.frameForRef(ref);
        let identity = await this.readIdentity(frame, ref);
        if (!identity) {
          // Node detached since perception — re-resolve by descriptor, once.
          const newRef = await this.resolveLocator(stored);
          if (!newRef) {
            return fail("stale_target", `target ${stored.role} "${stored.name}" disappeared before dispatch`);
          }
          ref = newRef;
          stored = this.refMap.get(ref)?.desc ?? stored;
          frame = this.frameForRef(ref);
          identity = await this.readIdentity(frame, ref);
        }
        if (!identity || identity.role !== stored.role || !nameMatch(identity.name, stored.name)) {
          const now = identity ? `${identity.role} "${identity.name}"` : "gone";
          return fail(
            "stale_target",
            `target changed since perception: expected ${stored.role} "${stored.name}", found ${now} — not dispatched`,
          );
        }
        resolvedTarget = { ...stored, name: identity.name };

        const sel = `[data-abt-ref="${ref}"]`;
        const loc = frame.locator(sel).first();
        const timeout = this.opts.actionTimeoutMs;
        await this.showIntent(frame, sel, this.describeForHud(action, identity.name), action.kind === "click");

        if (action.kind === "click") {
          const doubled = opts.forcedPerturbations
            ? opts.forcedPerturbations.some((p) => p.kind === "double_click")
            : opts.rng.chance(opts.persona.doubleClickChance);
          if (doubled) {
            // Same-task double dispatch — no await between the two clicks, so
            // the second cannot be preempted by the first request's response.
            // This is the recorded, replayable race stimulus.
            await frame.evaluate(
              `((sel) => { const el = document.querySelector(sel); if (!el) throw new Error("gone"); el.click(); el.click(); })(${JSON.stringify(sel)})`,
            );
            perturbations.push({ kind: "double_click" });
          } else {
            await loc.click({ timeout });
          }
        } else if (action.kind === "type") {
          // The real value is typed; only the RECORD is masked. Determined by
          // the field's identity (password input / sensitive-looking name).
          if (this.redactor.isSensitiveField(identity.name, identity.role)) {
            redactedText = this.redactor.maskField();
          }
          await loc.fill(action.text, { timeout });
          if (action.pressEnter) await loc.press("Enter", { timeout });
        } else if (action.kind === "select") {
          try {
            await loc.selectOption({ value: action.value }, { timeout });
          } catch {
            await loc.selectOption({ label: action.value }, { timeout });
          }
        } else {
          // upload: resolve the associated (usually hidden) file input.
          const foundInput = (await frame.evaluate(
            `${FILE_INPUT_SOURCE}(${JSON.stringify(sel)})`,
          )) as boolean;
          if (foundInput) {
            await frame.locator("[data-abt-upload]").first().setInputFiles(this.uploadPath, { timeout });
            this.transientBuf.push("file chosen: upload.png");
          } else {
            // No associated input findable — click and let the global
            // filechooser handler satisfy the chooser.
            await loc.click({ timeout });
            await page.waitForTimeout(400);
          }
        }
      } else if (action.kind === "navigate") {
        await this.showIntent(undefined, undefined, this.describeForHud(action), false);
        const target = new URL(action.url, this.opts.appUrl);
        const app = new URL(this.opts.appUrl);
        if (target.origin !== app.origin) {
          return fail("invalid_action", `navigation blocked: ${target.origin} is outside the app origin ${app.origin}`);
        }
        await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: this.opts.actionTimeoutMs });
      } else {
        await this.showIntent(undefined, undefined, this.describeForHud(action), false);
        if (action.kind === "back") {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: this.opts.actionTimeoutMs }).catch(() => {});
        } else if (action.kind === "press") {
          await page.keyboard.press(action.key);
        } else if (action.kind === "scroll") {
          await page.mouse.wheel(0, action.direction === "down" ? 600 : -600);
        } else if (action.kind === "wait") {
          await page.waitForTimeout(Math.min(action.ms, WAIT_CAP_MS));
        }
        // done / give_up: narrated above, no browser work.
      }

      await page.waitForLoadState("load", { timeout: 1500 }).catch(() => {});
      if (action.kind === "click" && this.mustPage().url() === urlBefore) {
        // A click's navigation may not have STARTED yet (the old document's
        // load state resolves instantly) — give an in-flight navigation a
        // beat so urlAfter reflects where the click actually took the user.
        await page.waitForTimeout(300);
        await this.mustPage()
          .waitForLoadState("domcontentloaded", { timeout: 1200 })
          .catch(() => {});
      }
      await this.harvestTransients();
      // The next decision is an LLM round-trip — say so, or the HUD looks stuck.
      if (action.kind !== "done" && action.kind !== "give_up") {
        await this.showIntent(undefined, undefined, "thinking about the next step…", false);
      }
      return {
        ok: true,
        urlAfter: this.redactor.url(this.mustPage().url()),
        perturbations,
        ...(resolvedTarget ? { resolvedTarget } : {}),
        ...(redactedText !== undefined ? { redactedText } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind: StepErrorKind = /Timeout/i.test(message)
        ? "timeout"
        : /net::|ERR_|navigat/i.test(message)
          ? "navigation_error"
          : "not_found";
      await this.harvestTransients();
      return fail(kind, message.slice(0, 300));
    }
  }

  /**
   * Watch mode only: glide the drawn cursor onto the target and narrate the
   * action in the HUD. Never throws — presentation must not fail a run.
   */
  private async showIntent(
    frame: Frame | undefined,
    selector: string | undefined,
    label: string,
    pulse: boolean,
  ): Promise<void> {
    if (!this.opts.watch) return;
    try {
      const target = frame ?? this.mustPage().mainFrame();
      const step = `step ${this.actCount}`;
      await target.evaluate(
        `${WATCH_UPDATE_SOURCE}(${JSON.stringify(selector ?? null)}, ${JSON.stringify(label)}, ${pulse}, ${JSON.stringify(step)})`,
      );
      if (selector) await this.mustPage().waitForTimeout(WATCH_CURSOR_SETTLE_MS);
    } catch {
      // overlay missing mid-navigation — irrelevant to the run
    }
  }

  private describeForHud(action: AgentAction, targetName?: string): string {
    const on = targetName ? ` “${targetName}”` : "";
    switch (action.kind) {
      case "click":
        return `clicking${on}`;
      case "type":
        return `typing “${action.text.slice(0, 40)}”${targetName ? ` into${on}` : ""}`;
      case "select":
        return `choosing “${action.value}”${on}`;
      case "upload":
        return `attaching a file via${on}`;
      case "navigate":
        return `going to ${action.url}`;
      case "press":
        return `pressing ${action.key}`;
      case "scroll":
        return `scrolling ${action.direction}`;
      case "back":
        return "going back";
      case "wait":
        return "waiting for the page";
      case "done":
        return `done — ${action.outcome}: ${action.summary.slice(0, 70)}`;
      case "give_up":
        return `giving up — ${action.reason.slice(0, 70)}`;
    }
  }

  private async readIdentity(frame: Frame, ref: string): Promise<{ role: string; name: string } | null> {
    const sel = `[data-abt-ref="${ref}"]`;
    try {
      return (await frame.evaluate(`${IDENTITY_SOURCE}(${JSON.stringify(sel)})`)) as {
        role: string;
        name: string;
      } | null;
    } catch {
      return null;
    }
  }

  private async harvestTransients(): Promise<void> {
    const page = this.page;
    if (!page) return;
    try {
      const found = (await page.evaluate(
        "(() => { const a = window.__abt_transients || []; window.__abt_transients = []; return a; })()",
      )) as string[];
      for (const t of found) {
        const safe = this.redactor.text(t);
        this.transientBuf.push(safe);
        this.transientEventBuf.push({ text: safe, atMs: Date.now() });
      }
    } catch {
      // page navigating — transients from the old document are gone; fine.
    }
  }

  drainIncidents(): IncidentDrain {
    const drain: IncidentDrain = {
      consoleDelta: this.consoleBuf,
      networkDelta: this.networkBuf,
      transientMessages: this.transientBuf,
      transientEvents: this.transientEventBuf,
      dialogs: this.dialogBuf,
      tabSwitched: this.tabSwitched,
    };
    this.consoleBuf = [];
    this.networkBuf = [];
    this.transientBuf = [];
    this.transientEventBuf = [];
    this.dialogBuf = [];
    this.tabSwitched = false;
    return drain;
  }

  async visibleText(): Promise<string> {
    try {
      return (await this.mustPage().evaluate(
        "(() => (document.body ? document.body.innerText : ''))()",
      )) as string;
    } catch {
      return "";
    }
  }

  currentUrl(): string {
    return this.mustPage().url();
  }

  async contextGet(url: string): Promise<{ status: number; body: string }> {
    if (!this.context) throw new Error("driver not started");
    const res = await this.context.request.get(url, { timeout: 5000, failOnStatusCode: false });
    return { status: res.status(), body: await res.text() };
  }

  async screenshot(absPath: string): Promise<void> {
    await this.mustPage().screenshot({ path: absPath, fullPage: false });
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }
}

export function createDriver(opts: DriverOptions): BrowserDriver {
  return new PlaywrightDriver(opts);
}
