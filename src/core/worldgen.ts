import type {
  AppBacktestConfig,
  PatienceLevel,
  PersonaConfig,
  ResolvedPersona,
  RunPlan,
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

/**
 * seed → deterministic WorldPlan. Sub-seeds key on stable identity
 * (`${seed}:${scenarioKey}:${i}`), never position: adding or removing a
 * scenario can never shift another scenario's sub-seeds or personas.
 */
export function generateWorld(config: AppBacktestConfig, seed: string): WorldPlan {
  const runs: RunPlan[] = [];
  for (const [scenarioKey, scenario] of Object.entries(config.scenarios)) {
    let personaKey: string;
    let personaConfig: PersonaConfig;
    if (typeof scenario.persona === "string") {
      const found = config.personas[scenario.persona];
      if (!found) {
        const known = Object.keys(config.personas).join(", ") || "(none defined)";
        throw new Error(
          `Scenario "${scenarioKey}" references unknown persona "${scenario.persona}" — defined personas: ${known}`,
        );
      }
      personaKey = scenario.persona;
      personaConfig = found;
    } else {
      personaKey = INLINE_PERSONA_KEY;
      personaConfig = scenario.persona;
    }
    const persona = resolvePersona(personaConfig);

    for (let i = 0; i < config.runs; i++) {
      const subSeed = `${seed}:${scenarioKey}:${i}`;
      runs.push({
        runId: newRunId(scenarioKey, subSeed),
        subSeed,
        scenarioKey,
        personaKey,
        goal: scenario.goal,
        persona,
        checks: scenario.checks,
      });
    }
  }
  return { seed, runs };
}
