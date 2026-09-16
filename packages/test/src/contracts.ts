import type { CaseSpec, FixtureDefinition, TestPlatform } from "@surfaceloom/core";

export interface CaseStep {
  /** Stable report id; the kernel. prefix is reserved for lifecycle records. */
  readonly id: string;
  readonly title: string;
  /** A fulfilled callback records these criteria as passed. */
  readonly criterionIds?: readonly string[];
}

export interface CaseContext {
  /** Reads an explicitly listed root fixture after all setup has completed. */
  fixture<T>(definition: FixtureDefinition<T>): T;
  /** Runs once, records completion, and rethrows failures. Await this promise. */
  step<T>(step: CaseStep, body: () => T | Promise<T>): Promise<T>;
  /** Records an explicit criterion check. The callback must throw on failure. */
  criterion<T>(id: string, check: () => T | Promise<T>): Promise<T>;
}

export interface CaseDefinition {
  readonly spec: CaseSpec;
  /** Execution resources remain separate from the long-lived CaseSpec. */
  readonly fixtures?: readonly FixtureDefinition<unknown>[];
  readonly run: (context: CaseContext) => void | Promise<void>;
}

export interface ExecuteCaseOptions {
  /** Caller-selected report platform, not a capability or host conformance claim. */
  readonly platform: TestPlatform;
}
