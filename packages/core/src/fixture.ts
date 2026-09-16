export type FixtureScope = "test" | "worker";

export interface FixtureContext {
  get<T>(fixture: FixtureDefinition<T>): T;
}

export interface FixtureResource<T> {
  readonly value: T;
  readonly teardown?: () => void | Promise<void>;
}

export interface FixtureDefinition<T> {
  readonly id: string;
  readonly scope?: FixtureScope;
  readonly dependencies?: readonly FixtureDefinition<unknown>[];
  readonly setup: (
    context: FixtureContext,
  ) => FixtureResource<T> | Promise<FixtureResource<T>>;
}

export function defineFixture<const T extends FixtureDefinition<unknown>>(
  fixture: T,
): Readonly<T> {
  assertFixtureId(fixture.id);
  if (fixture.scope !== undefined && fixture.scope !== "test" && fixture.scope !== "worker") {
    throw new Error(`Unknown fixture scope: ${String(fixture.scope)}`);
  }
  const dependencyIds = fixture.dependencies?.map((dependency) => dependency.id) ?? [];
  if (new Set(dependencyIds).size !== dependencyIds.length) {
    throw new Error(`Fixture ${fixture.id} declares a dependency more than once.`);
  }
  return Object.freeze({
    ...fixture,
    ...(fixture.dependencies === undefined
      ? {}
      : { dependencies: Object.freeze([...fixture.dependencies]) }),
  });
}

export function assertFixtureId(id: string): void {
  if (id.trim().length === 0) throw new Error("A fixture id must not be empty.");
}
