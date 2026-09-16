import { defineFixture, type FixtureContext, type FixtureDefinition } from "@surfaceloom/core";

/** Snapshots the graph while adapting original provider identities to Core's frozen graph. */
export function snapshotFixtures(roots: readonly FixtureDefinition<unknown>[]): {
  readonly definitions: readonly FixtureDefinition<unknown>[];
  readonly resolve: <T>(fixture: FixtureDefinition<T>) => FixtureDefinition<T>;
} {
  const snapshots = new Map<FixtureDefinition<unknown>, FixtureDefinition<unknown>>();
  const visiting = new Set<FixtureDefinition<unknown>>();
  const resolve = <T>(fixture: FixtureDefinition<T>): FixtureDefinition<T> =>
    (snapshots.get(fixture) ?? fixture) as FixtureDefinition<T>;

  function visit(fixture: FixtureDefinition<unknown>): FixtureDefinition<unknown> {
    const existing = snapshots.get(fixture);
    if (existing !== undefined) return existing;
    if (visiting.has(fixture)) throw new Error("Fixture dependency cycle in case definition.");
    visiting.add(fixture);
    const saved = defineFixture(fixture);
    if (typeof saved.setup !== "function") throw new Error("A case fixture needs a setup function.");
    const dependencies = saved.dependencies?.map(visit);
    const snapshot = defineFixture({
      id: saved.id,
      ...(saved.scope === undefined ? {} : { scope: saved.scope }),
      ...(dependencies === undefined ? {} : { dependencies }),
      setup: (context: FixtureContext) => saved.setup(Object.freeze({
        get: <T>(dependency: FixtureDefinition<T>): T => context.get(resolve(dependency)),
      })),
    });
    snapshots.set(fixture, snapshot);
    visiting.delete(fixture);
    return snapshot;
  }

  return { definitions: Object.freeze(roots.map(visit)), resolve };
}
