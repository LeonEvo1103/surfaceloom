import { parseTestId, type TestId } from "./ids.js";
import { readSafeArrayEnvelope } from "./safe-data.js";
import type { TestDefinition } from "./test-definition.js";
import { validateTestDefinition } from "./validate-definition.js";

const maxCatalogDefinitions = 1_000;

/** In-memory immutable registry. It performs no execution or discovery. */
export class TestCatalog {
  readonly #definitions = new Map<TestId, Readonly<TestDefinition>>();

  constructor(definitions: readonly unknown[] = []) {
    const safeDefinitions = readSafeArrayEnvelope(
      definitions,
      "TestCatalog definitions",
      maxCatalogDefinitions,
    );
    for (const definition of safeDefinitions) this.register(definition);
  }

  register(input: unknown): Readonly<TestDefinition> {
    const definition = validateTestDefinition(input);
    if (this.#definitions.has(definition.testId)) {
      throw new Error(`Duplicate service testId: ${definition.testId}`);
    }
    this.#definitions.set(definition.testId, definition);
    return definition;
  }

  get(testId: TestId | string): Readonly<TestDefinition> | undefined {
    return this.#definitions.get(parseTestId(testId));
  }

  require(testId: TestId | string): Readonly<TestDefinition> {
    const parsed = parseTestId(testId);
    const definition = this.#definitions.get(parsed);
    if (definition === undefined) throw new Error(`Unknown service testId: ${parsed}`);
    return definition;
  }

  has(testId: TestId | string): boolean {
    return this.#definitions.has(parseTestId(testId));
  }

  list(): readonly Readonly<TestDefinition>[] {
    return Object.freeze(
      [...this.#definitions.values()].sort((left, right) => left.testId.localeCompare(right.testId)),
    );
  }

  get size(): number {
    return this.#definitions.size;
  }
}
