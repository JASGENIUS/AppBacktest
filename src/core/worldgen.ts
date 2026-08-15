import type {
  AppBacktestConfig,
  PatienceLevel,
  PersonaConfig,
  ResolvedActor,
  ResolvedPersona,
  RunPlan,
  ScenarioConfig,
  WorldPlan,
} from "./types";
import { newRunId } from "./ids";

const MAX_STEPS: Record<PatienceLevel, number> = { low: 12, normal: 20, high: 30 };

/** Persona key recorded for scenarios that define their persona inline. */
const INLINE_PERSONA_KEY = "inline";

/**
 * Apply persona defaults: desktop, normal patience (20 steps; low=12, high=30),
 * doubleClickChance 0, uploadSizeKB 200, no traits.
 */
export function resolvePersona(p: PersonaConfig | undefined): ResolvedPersona {
  const patience = p?.patience ?? "normal";
  return {
    device: p?.device ?? "desktop",
    patience,
    maxSteps: MAX_STEPS[patience],
    doubleClickChance: p?.doubleClickChance ?? 0,
    uploadSizeKB: p?.uploadSizeKB ?? 200,
    traits: p?.traits ?? [],
  };
}

/** Look up a persona reference, with an actionable error when it is unknown. */
function lookupPersona(
  config: AppBacktestConfig,
  scenarioKey: string,
  ref: string | PersonaConfig | undefined,
): { personaKey: string; persona: ResolvedPersona } {
  if (typeof ref === "string") {
    const found = config.personas[ref];
    if (!found) {
      const known = Object.keys(config.personas).join(", ") || "(none defined)";
      throw new Error(
        `Scenario "${scenarioKey}" references unknown persona "${ref}" — defined personas: ${known}`,
      );
    }
    return { personaKey: ref, persona: resolvePersona(found) };
  }
  return { personaKey: INLINE_PERSONA_KEY, persona: resolvePersona(ref) };
}

function resolveActors(config: AppBacktestConfig, scenarioKey: string, scenario: ScenarioConfig): ResolvedActor[] {
  return (scenario.concurrent ?? []).map((actor) => {
    const { personaKey, persona } = lookupPersona(config, scenarioKey, actor.persona);
    return { name: actor.name, personaKey, goal: actor.goal, persona };
  });
}

/**
 * seed → deterministic WorldPlan. Sub-seeds key on stable identity
 * (`${seed}:${scenarioKey}:${i}`), never position: adding or removing a
 * scenario can never shift another scenario's sub-seeds or personas.
 */
export function generateWorld(config: AppBacktestConfig, seed: string): WorldPlan {
  const runs: RunPlan[] = [];
  for (const [scenarioKey, scenario] of Object.entries(config.scenarios)) {
    const actors = resolveActors(config, scenarioKey, scenario);
    const isConcurrent = actors.length > 0;

    // For a concurrent scenario the top-level plan fields describe actor 0,
    // so every consumer that predates multi-user still reads something true.
    const primary = isConcurrent
      ? { personaKey: actors[0]!.personaKey, persona: actors[0]!.persona, goal: actors[0]!.goal }
      : (() => {
          const { personaKey, persona } = lookupPersona(config, scenarioKey, scenario.persona);
          return { personaKey, persona, goal: scenario.goal ?? "" };
        })();

    for (let i = 0; i < config.runs; i++) {
      const subSeed = `${seed}:${scenarioKey}:${i}`;
      runs.push({
        runId: newRunId(scenarioKey, subSeed),
        subSeed,
        scenarioKey,
        personaKey: primary.personaKey,
        goal: primary.goal,
        persona: primary.persona,
        checks: scenario.checks,
        ...(isConcurrent ? { actors } : {}),
      });
    }
  }
  return { seed, runs };
}
