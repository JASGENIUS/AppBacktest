import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config";
import { generateWorld } from "../src/core/worldgen";
import { FixtureProvider } from "../src/providers/fixture";
import { resolvePersona } from "../src/core/worldgen";
import type { DecideContext, Perception } from "../src/core/types";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "abt-conc-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function writeConfig(body: string): string {
  const dir = tmp();
  const path = join(dir, "appbacktest.yaml");
  writeFileSync(path, body);
  return path;
}

const BASE = `
app: { name: T, url: "http://localhost:1" }
provider: { type: fixture, path: ./f.json }
personas:
  a: { patience: low }
  b: { patience: high }
`;

describe("multi-user scenarios — config", () => {
  it("accepts a concurrent scenario and resolves each actor's persona", () => {
    const path = writeConfig(`${BASE}
scenarios:
  together:
    concurrent:
      - { name: ana, persona: a, goal: "do the first thing" }
      - { name: ben, persona: b, goal: "do the second thing" }
    checks:
      - { type: text, contains: "ok" }
`);
    const world = generateWorld(loadConfig(path), "seed1");
    const plan = world.runs[0]!;
    expect(plan.actors).toHaveLength(2);
    expect(plan.actors!.map((a) => a.name)).toEqual(["ana", "ben"]);
    // Each actor keeps its own persona — different patience means different budgets.
    expect(plan.actors![0]!.persona.maxSteps).toBe(12);
    expect(plan.actors![1]!.persona.maxSteps).toBe(30);
    // Top-level fields describe actor 0 so older consumers still read something true.
    expect(plan.personaKey).toBe("a");
    expect(plan.goal).toBe(plan.actors![0]!.goal);
  });

  it("rejects mixing a scenario-level persona with concurrent actors", () => {
    const path = writeConfig(`${BASE}
scenarios:
  bad:
    persona: a
    goal: "this should not be here"
    concurrent:
      - { name: ana, persona: a, goal: "do the first thing" }
      - { name: ben, persona: b, goal: "do the second thing" }
    checks: []
`);
    expect(() => loadConfig(path)).toThrow(/remove the scenario-level persona/i);
  });

  it("rejects duplicate actor names", () => {
    const path = writeConfig(`${BASE}
scenarios:
  bad:
    concurrent:
      - { name: ana, persona: a, goal: "do the first thing" }
      - { name: ana, persona: b, goal: "do the second thing" }
    checks: []
`);
    expect(() => loadConfig(path)).toThrow(/unique/i);
  });

  it("still requires persona + goal for a single-actor scenario", () => {
    const path = writeConfig(`${BASE}
scenarios:
  bad:
    checks: []
`);
    expect(() => loadConfig(path)).toThrow(/either persona \+ goal, or a concurrent list/i);
  });

  it("keeps sub-seeds keyed on identity, so adding an actor cannot reshuffle other scenarios", () => {
    const twoActors = `${BASE}
scenarios:
  solo: { persona: a, goal: "just one user", checks: [] }
  together:
    concurrent:
      - { name: ana, persona: a, goal: "do the first thing" }
      - { name: ben, persona: b, goal: "do the second thing" }
    checks: []
`;
    const threeActors = twoActors.replace(
      `      - { name: ben, persona: b, goal: "do the second thing" }`,
      `      - { name: ben, persona: b, goal: "do the second thing" }\n      - { name: cara, persona: a, goal: "do the third thing" }`,
    );
    const before = generateWorld(loadConfig(writeConfig(twoActors)), "s");
    const after = generateWorld(loadConfig(writeConfig(threeActors)), "s");
    const solo = (w: typeof before) => w.runs.find((r) => r.scenarioKey === "solo")!;
    expect(solo(after).subSeed).toBe(solo(before).subSeed);
    expect(solo(after).runId).toBe(solo(before).runId);
  });
});

describe("multi-user scenarios — per-actor fixtures", () => {
  function ctx(actorName: string): DecideContext {
    const perception: Perception = {
      url: "http://localhost:1/",
      title: "T",
      textDigest: "",
      elements: [{ ref: "e1", role: "textbox", name: "Assign to", nth: 0 }],
    };
    return {
      goal: "g",
      actorName,
      persona: resolvePersona({}),
      appUrl: "http://localhost:1",
      stepIndex: 0,
      maxSteps: 10,
      history: [],
      perception,
    };
  }

  it("gives each actor its own decision list", async () => {
    const dir = tmp();
    const path = join(dir, "concurrent.json");
    writeFileSync(
      path,
      JSON.stringify({
        actors: {
          ana: { decisions: [{ kind: "type", ref: { nameContains: "Assign to" }, text: "ana" }] },
          ben: { decisions: [{ kind: "type", ref: { nameContains: "Assign to" }, text: "ben" }] },
        },
      }),
    );
    const forAna = await new FixtureProvider(path).decide(ctx("ana"));
    const forBen = await new FixtureProvider(path).decide(ctx("ben"));
    expect(forAna).toMatchObject({ kind: "type", text: "ana" });
    expect(forBen).toMatchObject({ kind: "type", text: "ben" });
  });

  it("names the available actors when one is missing", async () => {
    const dir = tmp();
    const path = join(dir, "concurrent.json");
    writeFileSync(path, JSON.stringify({ actors: { ana: { decisions: [] } } }));
    await expect(new FixtureProvider(path).decide(ctx("zoe"))).rejects.toThrow(
      /no decisions for actor "zoe".*ana/is,
    );
  });

  it("still supports the single-actor shape", async () => {
    const dir = tmp();
    const path = join(dir, "single.json");
    writeFileSync(
      path,
      JSON.stringify({ decisions: [{ kind: "type", ref: { nameContains: "Assign to" }, text: "solo" }] }),
    );
    const action = await new FixtureProvider(path).decide({ ...ctx("ana"), actorName: undefined });
    expect(action).toMatchObject({ kind: "type", text: "solo" });
  });
});
