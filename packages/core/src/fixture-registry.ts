import type { ComponentManifest } from "./component.js";
import { assertFixtureId, type FixtureDefinition } from "./fixture.js";

/** Connects machine-readable fixture ids to product-owned executable setup. */
export class FixtureRegistry {
  readonly #definitions = new Map<string, FixtureDefinition<unknown>>();

  constructor(definitions: readonly FixtureDefinition<unknown>[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register<T>(definition: FixtureDefinition<T>): void {
    assertFixtureId(definition.id);
    if (this.#definitions.has(definition.id)) {
      throw new Error(`Fixture ${definition.id} is already registered.`);
    }
    this.#definitions.set(definition.id, definition);
  }

  require<T = unknown>(id: string): FixtureDefinition<T> {
    const definition = this.#definitions.get(id);
    if (definition === undefined) {
      throw new Error(`No executable fixture is registered for ${id}.`);
    }
    return definition as FixtureDefinition<T>;
  }

  resolve(ids: readonly string[]): readonly FixtureDefinition<unknown>[] {
    return Object.freeze(ids.map((id) => this.require(id)));
  }

  validateComponentManifests(manifests: readonly ComponentManifest[]): void {
    for (const manifest of manifests) {
      for (const fixture of manifest.requiredFixtures ?? []) {
        if (!this.#definitions.has(fixture)) {
          throw new Error(
            `Component ${manifest.id} requires unregistered fixture ${fixture}.`,
          );
        }
      }
    }
  }

  listIds(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()].sort());
  }
}
