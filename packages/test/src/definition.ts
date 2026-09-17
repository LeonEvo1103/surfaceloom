import { defineCaseSpec, type FixtureDefinition } from "@surfaceloom/core";
import { redactReportText } from "@surfaceloom/reporter";
import type { CaseContext, CaseDefinition } from "./contracts.js";
import { snapshotFixtures } from "./fixture-snapshot.js";

const definedCases = new WeakSet<CaseDefinition>();

export function defineCase(definition: CaseDefinition): Readonly<CaseDefinition> {
  if (definedCases.has(definition)) return definition;
  const spec = defineCaseSpec(definition.spec);
  for (const id of [spec.id, spec.suite.id,
    ...spec.preconditions.map((clause) => clause.id),
    ...spec.acceptanceCriteria.map((clause) => clause.id)]) {
    assertIdentifier(id);
  }
  const run = definition.run;
  if (typeof run !== "function") throw new Error("A case needs a run function.");
  const fixtures = definition.fixtures ?? [];
  if (!Array.isArray(fixtures)) throw new Error("Case fixtures must be an array.");
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (typeof fixture.id !== "string" || fixture.id.trim().length === 0
        || typeof fixture.setup !== "function") {
      throw new Error("A case fixture needs an id and setup function.");
    }
    if (ids.has(fixture.id)) throw new Error(`Duplicate case fixture: ${fixture.id}.`);
    ids.add(fixture.id);
  }
  const snapshots = snapshotFixtures(fixtures);
  const defined: Readonly<CaseDefinition> = Object.freeze({
    spec, fixtures: snapshots.definitions,
    run: (context: CaseContext) => run(Object.freeze({
      ...context,
      fixture: <T>(fixture: FixtureDefinition<T>): T => context.fixture(snapshots.resolve(fixture)),
    })),
  });
  definedCases.add(defined);
  return defined;
}

/** Explicit, instance-local registration; importing a module does not register cases. */
export class CaseRegistry {
  readonly #definitions = new Map<string, Readonly<CaseDefinition>>();

  constructor(definitions: readonly CaseDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: CaseDefinition): Readonly<CaseDefinition> {
    const validated = defineCase(definition);
    if (this.#definitions.has(validated.spec.id)) {
      throw new Error(`Case ${validated.spec.id} is already registered.`);
    }
    this.#definitions.set(validated.spec.id, validated);
    return validated;
  }

  require(id: string): Readonly<CaseDefinition> {
    const definition = this.#definitions.get(id);
    if (definition === undefined) throw new Error(`No case is registered for ${id}.`);
    return definition;
  }

  list(): readonly Readonly<CaseDefinition>[] {
    return Object.freeze([...this.#definitions.values()]);
  }
}

export function assertIdentifier(id: string): void {
  if (typeof id !== "string" || id.length > 200
      || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(id)
      || redactReportText(id) !== id) {
    throw new Error("A report id must be a stable machine id without credential-like data.");
  }
}
