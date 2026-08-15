import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Rng } from "../src/core/rng";
import { configHash, sha256, stableStringify } from "../src/core/hash";
import { newRunId } from "../src/core/ids";
import { loadConfig, resolveUrl } from "../src/core/config";
import { generateWorld } from "../src/core/worldgen";
import type { AppBacktestConfig, RunPlan } from "../src/core/types";

function draws(rng: Rng, n: number): number[] {
  return Array.from({ length: n }, () => rng.next());
}

describe("core/rng", () => {
  it("same seed produces identical draw sequences; different seeds differ", () => {
    expect(draws(new Rng("739281"), 20)).toEqual(draws(new Rng("739281"), 20));
    expect(draws(new Rng("739281"), 20)).not.toEqual(draws(new Rng("739282"), 20));
  });

  it("fork purity: forks depend only on the label path, never on parent consumption", () => {
    const r1 = new Rng("seed-x");
    const seqA1 = draws(r1.fork("a"), 5);
    draws(r1, 5); // consume parent draws between forks
    const seqB1 = draws(r1.fork("b"), 5);

    // Fresh rng, zero parent draws: forks must yield the exact same streams.
    const r2 = new Rng("seed-x");
    expect(draws(r2.fork("a"), 5)).toEqual(seqA1);
    expect(draws(r2.fork("b"), 5)).toEqual(seqB1);

    // Sibling forks are distinct streams with the full label path recorded.
    expect(seqA1).not.toEqual(seqB1);
    expect(new Rng("seed-x").fork("a").labelPath).toBe("seed-x:a");
    expect(new Rng("seed-x").fork("a").fork("c").labelPath).toBe("seed-x:a:c");
  });

  it("forking never changes the parent's next draws", () => {
    const untouched = new Rng("seed-y");
    const expected = draws(untouched, 5);

    const forkedFrom = new Rng("seed-y");
    forkedFrom.fork("a");
    forkedFrom.fork("b");
    forkedFrom.fork("a").fork("nested");
    expect(draws(forkedFrom, 5)).toEqual(expected);
  });

  it("int stays in bounds, chance is deterministic, pick throws on empty", () => {
    const rng = new Rng("bounds");
    for (let i = 0; i < 200; i++) {
      const v = rng.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
    expect(new Rng("c").chance(0.5)).toBe(new Rng("c").chance(0.5));
    expect(() => new Rng("p").pick([])).toThrow(/empty/);
  });
});

describe("core/hash", () => {
  it("sha256 matches known vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("stableStringify is invariant to object key order, arrays keep order", () => {
    const a = { outer: { b: 2, a: 1 }, list: [2, 1], s: "x" };
    const b = { s: "x", list: [2, 1], outer: { a: 1, b: 2 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify({ u: undefined, k: 1 })).toBe('{"k":1}');
  });
});

describe("core/ids", () => {
  it("newRunId is fs-safe: <scenario>-<hash8>-<timestamp14>", () => {
    expect(newRunId("pod_upload", "s:pod_upload:0")).toMatch(/^pod_upload-[0-9a-f]{8}-\d{14}$/);
    // Sanitization strips fs-hostile characters; hash still keys on subSeed.
    expect(newRunId("weird/key!", "s:weird:0")).toMatch(/^weird_key_-[0-9a-f]{8}-\d{14}$/);
  });
});

describe("core/config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "appbacktest-core-"));
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let fileCounter = 0;
  function writeYaml(content: string): string {
    const p = path.join(tmpDir, `config-${fileCounter++}.yaml`);
    fs.writeFileSync(p, content, "utf8");
    return p;
  }

  const validYaml = `
app:
  name: Demo
  url: http://localhost:4173
  resetHook: { method: POST, url: /api/reset }
provider:
  type: anthropic
  model: claude-opus-5
  effort: low
personas:
  driver:
    device: desktop
    patience: normal
    doubleClickChance: 0.35
    uploadSizeKB: 400
    traits: ["in a hurry"]
scenarios:
  pod_upload:
    persona: driver
    goal: Upload a proof-of-delivery photo and confirm it was accepted.
    checks:
      - { type: url, contains: "/loads/" }
      - { type: text, contains: "Upload received" }
      - { type: http, url: /api/loads/38419/pods, count: 1 }
`;

  it("valid YAML round-trips with all defaults applied", () => {
    const cfg = loadConfig(writeYaml(validYaml));
    expect(cfg.app.name).toBe("Demo");
    expect(cfg.provider).toEqual({ type: "anthropic", model: "claude-opus-5", effort: "low" });
    expect(cfg.runs).toBe(1);
    expect(cfg.browser).toEqual({ headless: true, actionTimeoutMs: 8000, watch: false });
    expect(cfg.observers).toEqual({ ignoreConsole: [], ignoreRequests: [] });
    expect(cfg.outDir).toBe(".backtests");
    expect(cfg.personas["driver"]?.doubleClickChance).toBe(0.35);
    expect(cfg.scenarios["pod_upload"]?.checks).toHaveLength(3);
  });

  it("unknown keys error and the message names the key", () => {
    expect(() => loadConfig(writeYaml(`${validYaml}\nbogusExtra: 1\n`))).toThrow(/bogusExtra/);
  });

  it("fixture provider without path errors at provider.path", () => {
    const yaml = validYaml.replace(
      /provider:[\s\S]*?effort: low/,
      "provider:\n  type: fixture",
    );
    expect(() => loadConfig(writeYaml(yaml))).toThrow(/provider\.path/);
  });

  it("scenario referencing an unknown persona errors and names it", () => {
    const yaml = validYaml.replace("persona: driver", "persona: ghost");
    expect(() => loadConfig(writeYaml(yaml))).toThrow(/ghost/);
  });

  it("http check without count/equals/expectStatus errors", () => {
    const yaml = validYaml.replace(
      "- { type: http, url: /api/loads/38419/pods, count: 1 }",
      "- { type: http, url: /api/loads/38419/pods }",
    );
    expect(() => loadConfig(writeYaml(yaml))).toThrow(/at least one of/);
  });

  it("resolveUrl resolves relative paths and leaves absolute URLs untouched", () => {
    expect(resolveUrl("http://localhost:4173", "/api/x")).toBe("http://localhost:4173/api/x");
    expect(resolveUrl("http://localhost:4173", "https://example.com/a?b=1")).toBe(
      "https://example.com/a?b=1",
    );
  });
});

describe("core/worldgen", () => {
  function baseConfig(): AppBacktestConfig {
    return {
      app: { name: "T", url: "http://localhost:4000" },
      provider: { type: "fixture", path: "./fixtures/driver.json" },
      personas: { driver: { patience: "low", doubleClickChance: 0.5 } },
      scenarios: {
        A: { persona: "driver", goal: "Do the first thing properly", checks: [{ type: "url", contains: "/a" }] },
        B: { persona: { device: "mobile", patience: "high" }, goal: "Do the second thing properly", checks: [] },
      },
      runs: 2,
      browser: { headless: true, actionTimeoutMs: 8000 },
      observers: { ignoreConsole: [], ignoreRequests: [] },
      outDir: ".backtests",
    };
  }

  function byScenario(runs: RunPlan[], key: string): RunPlan[] {
    return runs.filter((r) => r.scenarioKey === key);
  }

  it("sub-seeds key on stable identity and persona defaults resolve", () => {
    const world = generateWorld(baseConfig(), "wseed");
    expect(byScenario(world.runs, "A").map((r) => r.subSeed)).toEqual(["wseed:A:0", "wseed:A:1"]);
    const a0 = byScenario(world.runs, "A")[0]!;
    expect(a0.persona).toEqual({
      device: "desktop",
      patience: "low",
      maxSteps: 12,
      doubleClickChance: 0.5,
      uploadSizeKB: 200,
      traits: [],
    });
    expect(a0.personaKey).toBe("driver");
    const b0 = byScenario(world.runs, "B")[0]!;
    expect(b0.persona.maxSteps).toBe(30);
    expect(b0.personaKey).toBe("inline");
  });

  it("adding a scenario leaves sibling sub-seeds and personas byte-identical", () => {
    const before = generateWorld(baseConfig(), "wseed");

    const withC = baseConfig();
    withC.scenarios["C"] = {
      persona: "driver",
      goal: "Do a brand new third thing",
      checks: [],
    };
    const after = generateWorld(withC, "wseed");

    for (const key of ["A", "B"]) {
      const b = byScenario(before.runs, key);
      const a = byScenario(after.runs, key);
      expect(a.map((r) => r.subSeed)).toEqual(b.map((r) => r.subSeed));
      expect(a.map((r) => stableStringify(r.persona))).toEqual(
        b.map((r) => stableStringify(r.persona)),
      );
    }
    expect(byScenario(after.runs, "C").map((r) => r.subSeed)).toEqual(["wseed:C:0", "wseed:C:1"]);
  });

  it("configHash is invariant to key insertion order", () => {
    const reordered: AppBacktestConfig = JSON.parse(stableStringify(baseConfig()));
    expect(configHash(reordered)).toBe(configHash(baseConfig()));
  });

  it("generateWorld throws readably on an unknown persona key", () => {
    const cfg = baseConfig();
    cfg.scenarios["A"]!.persona = "ghost";
    expect(() => generateWorld(cfg, "wseed")).toThrow(/unknown persona "ghost"/);
  });
});
