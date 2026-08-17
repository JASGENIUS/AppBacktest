import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { AppBacktestConfig } from "./types";

// Schemas mirror AppBacktestConfig exactly (see types.ts). .strict() everywhere:
// unknown keys are errors, per DESIGN.md §5.

const httpHookSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    url: z.string().min(1),
  })
  .strict();

const appSchema = z
  .object({
    name: z.string().min(1),
    url: z
      .string()
      .regex(/^https?:\/\//, "must be an absolute http(s) URL (e.g. http://localhost:4173)"),
    command: z.string().min(1).optional(),
    resetHook: httpHookSchema.optional(),
  })
  .strict();

const providerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("anthropic"),
      model: z.string().min(1).optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("openai_compatible"),
      baseUrl: z.string().url(),
      model: z.string().min(1),
      apiKeyEnv: z.string().min(1).optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().max(32000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fixture"),
      path: z.string().min(1),
    })
    .strict(),
]);

const personaSchema = z
  .object({
    device: z.enum(["desktop", "mobile"]).optional(),
    patience: z.enum(["low", "normal", "high"]).optional(),
    doubleClickChance: z.number().min(0).max(1).optional(),
    uploadSizeKB: z.number().int().positive().max(25000).optional(),
    traits: z.array(z.string()).optional(),
  })
  .strict();

const atField = z.string().min(1).optional();

const checkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("transient"), contains: z.string().min(1) }).strict(),
  z.object({ type: z.literal("url"), contains: z.string().min(1) }).strict(),
  z.object({ type: z.literal("text"), contains: z.string().min(1), at: atField }).strict(),
  z.object({ type: z.literal("no_text"), contains: z.string().min(1), at: atField }).strict(),
  z
    .object({ type: z.literal("element"), role: z.string().min(1), name: z.string().min(1), at: atField })
    .strict(),
  z
    .object({ type: z.literal("no_element"), role: z.string().min(1), name: z.string().min(1), at: atField })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      url: z.string().min(1),
      path: z.string().min(1).optional(),
      count: z.number().int().nonnegative().optional(),
      equals: z.unknown().optional(),
      expectStatus: z.number().int().optional(),
    })
    .strict()
    .refine((c) => c.count !== undefined || c.equals !== undefined || c.expectStatus !== undefined, {
      message: "http check requires at least one of: count, equals, expectStatus",
    }),
]);

const concurrentActorSchema = z
  .object({
    name: z.string().min(1),
    persona: z.union([z.string().min(1), personaSchema]),
    goal: z.string().min(8),
  })
  .strict();

const scenarioSchema = z
  .object({
    concurrent: z.array(concurrentActorSchema).min(2).max(6).optional(),
    persona: z.union([z.string().min(1), personaSchema]).optional(),
    goal: z.string().min(8, "goal must be at least 8 characters").optional(),
    checks: z.array(checkSchema),
  })
  .strict()
  .superRefine((s, ctx) => {
    // Exactly one shape: a single probe, or several concurrent ones.
    if (s.concurrent) {
      if (s.persona !== undefined || s.goal !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "a concurrent scenario defines persona and goal per actor — remove the scenario-level persona/goal",
        });
      }
      const names = s.concurrent.map((a) => a.name);
      if (new Set(names).size !== names.length) {
        ctx.addIssue({ code: "custom", message: "concurrent actor names must be unique" });
      }
    } else if (s.persona === undefined || s.goal === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "a scenario needs either persona + goal, or a concurrent list of actors",
      });
    }
  });

/**
 * Defaults chosen to stop the obvious secrets reaching disk without the user
 * configuring anything. Matched case-insensitively.
 */
const DEFAULT_FIELD_PATTERNS = [
  "password",
  "passcode",
  "\\bpin\\b",
  "secret",
  "token",
  "api[\\s_-]?key",
  "auth",
  "card|cvv|cvc|security code",
  "ssn|social security",
  "account number",
];
const DEFAULT_VALUE_PATTERNS = [
  "\\bsk-[A-Za-z0-9_-]{12,}",          // OpenAI-style keys
  "\\bnvapi-[A-Za-z0-9_-]{12,}",       // NVIDIA
  "\\bghp_[A-Za-z0-9]{20,}",           // GitHub
  "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}", // JWT
  "\\b\\d{13,16}\\b",                  // card-length digit runs
];

const redactionSchema = z
  .object({
    enabled: z.boolean().default(true),
    fieldPatterns: z.array(z.string()).default(DEFAULT_FIELD_PATTERNS),
    valuePatterns: z.array(z.string()).default(DEFAULT_VALUE_PATTERNS),
    mask: z.string().default("[redacted]"),
  })
  .strict();

const uxSchema = z
  .object({
    level: z.enum(["off", "conservative", "balanced", "detailed"]).default("conservative"),
    minConfidence: z.number().min(0).max(1).default(0.7),
    maxRecommendations: z.number().int().min(0).max(50).default(3),
  })
  .strict();

const sourceSchema = z
  .object({
    // Read-only correlation; AppBacktest never writes to the user's source.
    enabled: z.boolean().default(false),
    root: z.string().min(1).optional(),
    maxFiles: z.number().int().positive().max(20000).default(4000),
  })
  .strict();

const replaySchema = z
  .object({
    beforeMs: z.number().int().min(0).max(600000).default(20000),
    afterMs: z.number().int().min(0).max(600000).default(10000),
  })
  .strict();

const browserSchema = z
  .object({
    headless: z.boolean().default(true),
    actionTimeoutMs: z.number().int().positive().default(8000),
    // Usually set by the CLI's --watch flag rather than written in config.
    watch: z.boolean().default(false),
  })
  .strict();

const observerSchema = z
  .object({
    ignoreConsole: z.array(z.string()).default([]),
    ignoreRequests: z.array(z.string()).default([]),
  })
  .strict();

const configSchema = z
  .object({
    app: appSchema,
    provider: providerSchema,
    personas: z.record(z.string(), personaSchema).default({}),
    scenarios: z.record(z.string(), scenarioSchema),
    runs: z.number().int().min(1).max(50).default(1),
    browser: browserSchema.default({ headless: true, actionTimeoutMs: 8000, watch: false }),
    observers: observerSchema.default({ ignoreConsole: [], ignoreRequests: [] }),
    redaction: redactionSchema.default({
      enabled: true,
      fieldPatterns: DEFAULT_FIELD_PATTERNS,
      valuePatterns: DEFAULT_VALUE_PATTERNS,
      mask: "[redacted]",
    }),
    ux: uxSchema.default({ level: "conservative", minConfidence: 0.7, maxRecommendations: 3 }),
    source: sourceSchema.default({ enabled: false, maxFiles: 4000 }),
    replay: replaySchema.default({ beforeMs: 20000, afterMs: 10000 }),
    outDir: z.string().min(1).default(".backtests"),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const [scenarioKey, scenario] of Object.entries(cfg.scenarios)) {
      if (typeof scenario.persona === "string" && !(scenario.persona in cfg.personas)) {
        const known = Object.keys(cfg.personas).join(", ") || "(none defined)";
        ctx.addIssue({
          code: "custom",
          path: ["scenarios", scenarioKey, "persona"],
          message: `unknown persona "${scenario.persona}" — defined personas: ${known}`,
        });
      }
    }
  });

function formatIssuePath(issuePath: PropertyKey[]): string {
  return issuePath.length === 0 ? "(root)" : issuePath.map(String).join(".");
}

/**
 * Load + validate an appbacktest YAML config. Applies all defaults; resolves
 * nothing else. Throws an Error listing every problem as "<dotted.path>: <message>".
 */
export function loadConfig(configPath: string): AppBacktestConfig {
  const abs = path.resolve(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`Cannot read config file ${abs}: ${(err as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in ${abs}: ${(err as Error).message}`);
  }

  const result = configSchema.safeParse(doc);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${formatIssuePath(i.path)}: ${i.message}`);
    throw new Error(`Invalid config ${abs}:\n${lines.join("\n")}`);
  }
  const config = result.data;
  // Relative fixture paths mean "relative to the config file", not the cwd —
  // resolve here so every consumer downstream sees an absolute path.
  if (config.provider.type === "fixture" && !path.isAbsolute(config.provider.path)) {
    config.provider.path = path.resolve(path.dirname(abs), config.provider.path);
  }
  return config;
}

/**
 * Resolve a possibly-relative URL against a base. Absolute http(s) URLs are
 * returned untouched (never re-serialized).
 */
export function resolveUrl(base: string, maybeRelative: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    throw new Error(`Cannot resolve URL "${maybeRelative}" against base "${base}"`);
  }
}
