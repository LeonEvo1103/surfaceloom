import {
  assertFixtureId,
  type FixtureContext,
  type FixtureDefinition,
  type FixtureScope,
} from "./fixture.js";

interface FixtureState<T = unknown> {
  readonly definition: FixtureDefinition<T>;
  readonly value: T;
  readonly teardown?: () => void | Promise<void>;
}

class FixtureCoordinator {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** On-demand fixtures with serialized setup and reverse-order teardown. */
export class FixtureRuntime {
  readonly #states = new Map<string, FixtureState>();
  readonly #setupOrder: string[] = [];
  readonly #children = new Set<FixtureRuntime>();
  readonly #scope: FixtureScope;
  readonly #parent: FixtureRuntime | undefined;
  readonly #coordinator: FixtureCoordinator;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(scope: FixtureScope = "test", parent?: FixtureRuntime) {
    if (parent !== undefined && (scope !== "test" || parent.#scope !== "worker")) {
      throw new Error("Only a test fixture runtime can have a worker parent.");
    }
    this.#scope = scope;
    this.#parent = parent;
    this.#coordinator =
      parent === undefined ? new FixtureCoordinator() : parent.#coordinator;
    if (parent !== undefined) {
      parent.assertAcceptingWork();
      parent.#children.add(this);
    }
  }

  createTestScope(): FixtureRuntime {
    this.assertAcceptingWork();
    if (this.#scope !== "worker") {
      throw new Error("Only a worker fixture runtime can create a test scope.");
    }
    const child = new FixtureRuntime("test", this);
    return child;
  }

  async use<T>(fixture: FixtureDefinition<T>): Promise<T> {
    this.assertAcceptingWork();
    return this.#coordinator.run(async () => {
      const target = this.runtimeFor(fixture);
      const checkpoint = target.#setupOrder.length;
      try {
        return await target.resolve(fixture, []);
      } catch (error) {
        const teardownErrors = await target.rollback(checkpoint);
        if (teardownErrors.length > 0) {
          throw new AggregateError(
            [error, ...teardownErrors],
            `Fixture ${fixture.id} setup and rollback both failed.`,
          );
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#scope === "worker" && this.#children.size > 0) {
      return Promise.reject(
        new Error("Close all test fixture scopes before closing their worker runtime."),
      );
    }
    this.#closing = true;
    this.#closePromise = this.#coordinator.run(async () => {
      this.#closed = true;
      const errors = await this.rollback(0);
      if (this.#parent !== undefined) this.#parent.#children.delete(this);
      if (errors.length > 0) {
        throw new AggregateError(errors, "One or more fixture teardowns failed.");
      }
    });
    return this.#closePromise;
  }

  private runtimeFor(fixture: FixtureDefinition<unknown>): FixtureRuntime {
    const scope = fixture.scope ?? "test";
    if (scope === this.#scope) return this;
    if (scope === "worker" && this.#parent !== undefined) return this.#parent;
    throw new Error(
      `Fixture ${fixture.id} has ${scope} scope and cannot run in ${this.#scope} scope.`,
    );
  }

  private async resolve<T>(
    fixture: FixtureDefinition<T>,
    ancestry: readonly string[],
  ): Promise<T> {
    assertFixtureId(fixture.id);
    const target = this.runtimeFor(fixture);
    if (target !== this) return target.resolve(fixture, ancestry);
    if (ancestry.includes(fixture.id)) {
      throw new Error(`Fixture dependency cycle: ${[...ancestry, fixture.id].join(" -> ")}`);
    }

    const existing = this.#states.get(fixture.id);
    if (existing !== undefined) {
      if (existing.definition !== fixture) {
        throw new Error(`Fixture id ${fixture.id} is registered more than once.`);
      }
      return existing.value as T;
    }

    for (const dependency of fixture.dependencies ?? []) {
      await this.resolveDependency(dependency, [...ancestry, fixture.id]);
    }
    return this.setup(fixture);
  }

  private async setup<T>(fixture: FixtureDefinition<T>): Promise<T> {
    const declaredDependencies = new Set(fixture.dependencies ?? []);
    const context: FixtureContext = {
      get: <U>(dependency: FixtureDefinition<U>): U => {
        if (!declaredDependencies.has(dependency)) {
          throw new Error(
            `Fixture ${dependency.id} is not a declared dependency of ${fixture.id}.`,
          );
        }
        return this.readResolvedDependency(dependency);
      },
    };
    const resource = await fixture.setup(context);
    this.#states.set(fixture.id, {
      definition: fixture,
      value: resource.value,
      ...(resource.teardown === undefined ? {} : { teardown: resource.teardown }),
    });
    this.#setupOrder.push(fixture.id);
    return resource.value;
  }

  private async resolveDependency(
    fixture: FixtureDefinition<unknown>,
    ancestry: readonly string[],
  ): Promise<void> {
    await this.runtimeFor(fixture).resolve(fixture, ancestry);
  }

  private readResolvedDependency<T>(fixture: FixtureDefinition<T>): T {
    const target = this.runtimeFor(fixture);
    const state = target.#states.get(fixture.id);
    if (state === undefined || state.definition !== fixture) {
      throw new Error(`Fixture ${fixture.id} was not resolved before setup read it.`);
    }
    return state.value as T;
  }

  private async rollback(checkpoint: number): Promise<unknown[]> {
    const errors: unknown[] = [];
    while (this.#setupOrder.length > checkpoint) {
      const id = this.#setupOrder.pop();
      if (id === undefined) break;
      const state = this.#states.get(id);
      this.#states.delete(id);
      try {
        await state?.teardown?.();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private assertAcceptingWork(): void {
    if (this.#closing || this.#closed) {
      throw new Error("Fixture runtime is already closing or closed.");
    }
  }
}
