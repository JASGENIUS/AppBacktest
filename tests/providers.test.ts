import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  AgentAction,
  DecideContext,
  PerceivedElement,
  ResolvedPersona,
} from "../src/core/types";
import {
  actionJsonSchema,
  actionVariants,
  parseAction,
  unwrapActionEnvelope,
} from "../src/providers/actionSchema";
import { AnthropicProvider } from "../src/providers/anthropic";
import { FixtureProvider } from "../src/providers/fixture";
import { createProvider } from "../src/providers/index";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "appbacktest-providers-"));
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let fixtureCounter = 0;
function writeFixture(decisions: unknown[]): string {
  const file = path.join(tmpDir, `fixture-${fixtureCounter++}.json`);
  fs.writeFileSync(file, JSON.stringify({ decisions }), "utf8");
  return file;
}

const persona: ResolvedPersona = {
  device: "desktop",
  patience: "normal",
  maxSteps: 20,
  doubleClickChance: 0,
  uploadSizeKB: 200,
  traits: [],
};

function el(ref: string, role: string, name: string): PerceivedElement {
  return { ref, role, name, nth: 0 };
}

function makeCtx(elements: PerceivedElement[]): DecideContext {
  return {
    goal: "Upload a POD photo for load #38419",
    persona,
    appUrl: "http://localhost:4173",
    stepIndex: 0,
    maxSteps: 20,
    history: [],
    perception: {
      url: "http://localhost:4173/loads",
      title: "POD Demo",
      textDigest: "Loads list. Load 38419 pending.",
      elements,
    },
  };
}

describe("parseAction", () => {
  it("accepts every action variant", () => {
    const samples: AgentAction[] = [
      { kind: "navigate", url: "/loads" },
      { kind: "click", ref: "e1" },
      { kind: "type", ref: "e2", text: "hello", pressEnter: true },
      { kind: "select", ref: "e3", value: "38419" },
      { kind: "upload", ref: "e4" },
      { kind: "press", key: "Escape" },
      { kind: "scroll", direction: "down" },
      { kind: "back" },
      { kind: "wait", ms: 2000 },
      { kind: "done", outcome: "success", summary: "uploaded the POD" },
      { kind: "give_up", reason: "no upload control anywhere" },
    ];
    for (const sample of samples) {
      expect(parseAction(sample)).toEqual(sample);
    }
  });

  it("rejects wait.ms above 2000 and below 1", () => {
    expect(() => parseAction({ kind: "wait", ms: 3000 })).toThrow(/Invalid agent action/);
    expect(() => parseAction({ kind: "wait", ms: 0 })).toThrow(/Invalid agent action/);
    expect(() => parseAction({ kind: "wait", ms: 1.5 })).toThrow(/Invalid agent action/);
  });

  it("rejects unknown kinds", () => {
    expect(() => parseAction({ kind: "hover", ref: "e1" })).toThrow(/Invalid agent action/);
    expect(() => parseAction({ kind: "", ref: "e1" })).toThrow(/Invalid agent action/);
    expect(() => parseAction(null)).toThrow(/Invalid agent action/);
  });

  it("rejects keys outside the whitelist and extra properties", () => {
    expect(() => parseAction({ kind: "press", key: "Delete" })).toThrow(/Invalid agent action/);
    expect(() => parseAction({ kind: "click", ref: "e1", force: true })).toThrow(
      /Invalid agent action/,
    );
    expect(() => parseAction({ kind: "done", outcome: "failure", summary: "x" })).toThrow(
      /Invalid agent action/,
    );
  });
});

describe("actionJsonSchema", () => {
  // Every parseAction-accepted variant must fit at least one anyOf branch:
  // kind const matches, required[] ⊆ sample keys, and (additionalProperties:
  // false) every sample key is declared in the branch's properties.
  const samples: AgentAction[] = [
    { kind: "navigate", url: "/loads" },
    { kind: "click", ref: "e1" },
    { kind: "type", ref: "e2", text: "hello", pressEnter: false },
    { kind: "select", ref: "e3", value: "38419" },
    { kind: "upload", ref: "e4" },
    { kind: "press", key: "ArrowDown" },
    { kind: "scroll", direction: "up" },
    { kind: "back" },
    { kind: "wait", ms: 250 },
    { kind: "done", outcome: "unsure", summary: "probably worked" },
    { kind: "give_up", reason: "stuck" },
  ];

  interface Branch {
    type: string;
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  }
  const branches = actionVariants as unknown as Branch[];

  it("is object-rooted with a required action envelope (API tool-schema shape)", () => {
    // Tool input_schema roots must be type:"object"; the union nests under
    // `action`, and providers unwrap it.
    expect(actionJsonSchema.type).toBe("object");
    expect(actionJsonSchema.required).toEqual(["action"]);
    expect(actionJsonSchema.additionalProperties).toBe(false);
    const props = actionJsonSchema.properties as { action: { anyOf: unknown[] } };
    expect(props.action.anyOf).toBe(actionVariants);
    expect(unwrapActionEnvelope({ action: { kind: "back" } })).toEqual({ kind: "back" });
    expect(unwrapActionEnvelope({ kind: "back" })).toEqual({ kind: "back" });
  });

  it("never uses numeric bounds (unsupported by strict structured outputs)", () => {
    const text = JSON.stringify(actionJsonSchema);
    expect(text).not.toContain('"minimum"');
    expect(text).not.toContain('"maximum"');
  });

  it("has one strict object branch per action kind", () => {
    expect(branches).toHaveLength(11);
    for (const branch of branches) {
      expect(branch.type).toBe("object");
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toContain("kind");
      expect(branch.properties.kind).toHaveProperty("const");
    }
  });

  it("structurally admits every parseAction-accepted variant", () => {
    for (const sample of samples) {
      const keys = Object.keys(sample);
      const fits = branches.some(
        (branch) =>
          branch.properties.kind?.const === sample.kind &&
          branch.required.every((r) => keys.includes(r)) &&
          keys.every((k) => k in branch.properties),
      );
      expect(fits, `no anyOf branch admits ${JSON.stringify(sample)}`).toBe(true);
    }
  });
});

describe("FixtureProvider", () => {
  it("consumes decisions sequentially and resolves nameContains targets", async () => {
    const file = writeFixture([
      { kind: "navigate", url: "/loads" },
      { kind: "click", ref: { role: "button", nameContains: "upload pod" } },
      { kind: "done", outcome: "success", summary: "uploaded" },
    ]);
    const provider = new FixtureProvider(file);
    expect(provider.name).toBe("fixture");
    // Whitespace-normalized + case-insensitive: "  Upload   POD " matches "upload pod".
    const ctx = makeCtx([
      el("e1", "link", "Home"),
      el("e2", "button", "  Upload   POD "),
      el("e3", "button", "Delete load"),
    ]);

    expect(await provider.decide(ctx)).toEqual({ kind: "navigate", url: "/loads" });
    expect(await provider.decide(ctx)).toEqual({ kind: "click", ref: "e2" });
    expect(await provider.decide(ctx)).toEqual({
      kind: "done",
      outcome: "success",
      summary: "uploaded",
    });
  });

  it("filters by role when the target gives one", async () => {
    const file = writeFixture([{ kind: "click", ref: { role: "button", nameContains: "upload" } }]);
    const provider = new FixtureProvider(file);
    const ctx = makeCtx([el("e1", "link", "Upload"), el("e2", "button", "Upload")]);
    expect(await provider.decide(ctx)).toEqual({ kind: "click", ref: "e2" });
  });

  it("passes plain string refs through untouched", async () => {
    const file = writeFixture([{ kind: "click", ref: "e7" }]);
    const provider = new FixtureProvider(file);
    expect(await provider.decide(makeCtx([]))).toEqual({ kind: "click", ref: "e7" });
  });

  it("gives up with a diagnostic naming the target and the first 10 element names", async () => {
    const file = writeFixture([{ kind: "click", ref: { nameContains: "nonexistent thing" } }]);
    const provider = new FixtureProvider(file);
    const elements = Array.from({ length: 12 }, (_, i) => el(`e${i + 1}`, "button", `Button ${i + 1}`));
    const action = await provider.decide(makeCtx(elements));

    expect(action.kind).toBe("give_up");
    const reason = (action as { kind: "give_up"; reason: string }).reason;
    expect(reason).toContain('name containing "nonexistent thing"');
    expect(reason).toContain("first 10 of 12");
    expect(reason).toContain("'Button 1'");
    expect(reason).toContain("'Button 10'");
    expect(reason).not.toContain("'Button 11'");
  });

  it("gives up when decisions are exhausted", async () => {
    const file = writeFixture([{ kind: "back" }]);
    const provider = new FixtureProvider(file);
    const ctx = makeCtx([]);
    expect(await provider.decide(ctx)).toEqual({ kind: "back" });
    expect(await provider.decide(ctx)).toEqual({
      kind: "give_up",
      reason: "fixture exhausted after 1 decisions",
    });
    // Stays exhausted on further calls.
    expect(await provider.decide(ctx)).toEqual({
      kind: "give_up",
      reason: "fixture exhausted after 1 decisions",
    });
  });

  it("reads the file lazily: construction never touches disk", async () => {
    const provider = new FixtureProvider(path.join(tmpDir, "does-not-exist.json"));
    await expect(provider.decide(makeCtx([]))).rejects.toThrow(/not readable/);
  });

  it("rejects files that are not {\"decisions\": [...]}", async () => {
    const file = path.join(tmpDir, "bad-shape.json");
    fs.writeFileSync(file, JSON.stringify({ steps: [] }), "utf8");
    const provider = new FixtureProvider(file);
    await expect(provider.decide(makeCtx([]))).rejects.toThrow(/{"decisions": \[\.\.\.\]}/);
  });

  it("names the decision index when a fixture decision fails validation", async () => {
    const file = writeFixture([{ kind: "wait", ms: 3000 }]);
    const provider = new FixtureProvider(file);
    await expect(provider.decide(makeCtx([]))).rejects.toThrow(/Fixture decision #0 invalid/);
  });
});

describe("AnthropicProvider", () => {
  it("constructs without an API key present (client is lazy)", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const provider = new AnthropicProvider();
      expect(provider.name).toBe("anthropic");
      const configured = new AnthropicProvider({ model: "claude-opus-5", effort: "high" });
      expect(configured.name).toBe("anthropic");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe("AnthropicProvider token metering", () => {
  /** Minimal stand-in for the SDK response we actually read. */
  function fakeResponse(action: unknown, usage: Record<string, number>) {
    return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "act", input: { action } }],
      usage,
    };
  }

  function providerWithClient(responses: unknown[]): {
    provider: AnthropicProvider;
    calls: number[];
  } {
    const provider = new AnthropicProvider();
    const calls: number[] = [];
    let i = 0;
    (provider as unknown as { client: unknown }).client = {
      messages: {
        create: async () => {
          calls.push(i);
          return responses[i++];
        },
      },
    };
    return { provider, calls };
  }

  it("accumulates input, output and cached tokens across decisions", async () => {
    const { provider } = providerWithClient([
      fakeResponse({ kind: "click", ref: "f0:e1" }, { input_tokens: 1200, output_tokens: 25 }),
      fakeResponse(
        { kind: "done", outcome: "success", summary: "uploaded" },
        { input_tokens: 1500, output_tokens: 40, cache_read_input_tokens: 900 },
      ),
    ]);

    await provider.decide(makeCtx([el("f0:e1", "button", "Upload")]));
    await provider.decide(makeCtx([el("f0:e1", "button", "Upload")]));

    expect(provider.usage).toEqual({
      calls: 2,
      inputTokens: 2700,
      outputTokens: 65,
      cacheReadTokens: 900,
    });
  });

  it("counts a corrective retry as a billed call, because it was one", async () => {
    // First response is an invalid action; the provider retries once. Both
    // round trips cost money and both must show up in the meter.
    const { provider } = providerWithClient([
      fakeResponse({ kind: "teleport" }, { input_tokens: 1000, output_tokens: 10 }),
      fakeResponse({ kind: "give_up", reason: "stuck" }, { input_tokens: 1100, output_tokens: 12 }),
    ]);

    const action = await provider.decide(makeCtx([el("f0:e1", "button", "Upload")]));

    expect(action.kind).toBe("give_up");
    expect(provider.usage.calls).toBe(2);
    expect(provider.usage.inputTokens).toBe(2100);
  });

  it("tolerates a response with no usage block rather than throwing", async () => {
    const { provider } = providerWithClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", name: "act", input: { action: { kind: "back" } } }] },
    ]);

    await provider.decide(makeCtx([el("f0:e1", "button", "Upload")]));

    expect(provider.usage).toEqual({
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("leaves the fixture provider unmetered, so free runs report no cost", () => {
    const fixture = new FixtureProvider(writeFixture([{ kind: "back" }]));
    expect(fixture.usage).toBeUndefined();
  });
});

describe("createProvider", () => {
  it("builds the provider matching cfg.type", () => {
    const fixture = createProvider({ type: "fixture", path: "fixtures/driver.json" });
    expect(fixture.name).toBe("fixture");
    expect(fixture).toBeInstanceOf(FixtureProvider);

    const anthropic = createProvider({ type: "anthropic", model: "claude-opus-5", effort: "low" });
    expect(anthropic.name).toBe("anthropic");
    expect(anthropic).toBeInstanceOf(AnthropicProvider);
  });
});
