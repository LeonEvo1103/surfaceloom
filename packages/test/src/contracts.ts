import type { CaseSpec, FixtureDefinition, TestPlatform } from "@surfaceloom/core";
import type { DeadlineTaskContext, ExecutionClock } from "./deadline-contracts.js";
import type { EffectDescriptor } from "./effects.js";
import type { ExecutionEnvironment, ExecutionPlan } from "./plan-contracts.js";
import type { ExecutionEffectPolicy } from "./policy-contracts.js";
import type { ResourceRegistration } from "./resources-contracts.js";

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
  /** Cooperative lifecycle cancellation; it does not imply forced JavaScript stop. */
  readonly signal: AbortSignal;
  remainingMs(): number;
  throwIfCancelled(): void;
  acknowledgeCancellation(): boolean;
  /** Registers an explicitly owned/borrowed resource for reverse-order cleanup. */
  registerResource(resource: ResourceRegistration): void;
  /** Authorizes and invokes one declared effect exactly once. */
  dispatch<T>(effect: EffectDescriptor,
    action: (authorized: Readonly<EffectDescriptor>) => T | Promise<T>): Promise<T>;
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
  /** Defaults to a legacy, empty-requirements plan bound to the CaseSpec. */
  readonly plan?: ExecutionPlan;
  /** Defaults to an empty environment matching the selected report platform. */
  readonly environment?: ExecutionEnvironment;
  readonly policy?: ExecutionEffectPolicy;
  /** Whole lifecycle budget: setup, body, pending steps, and cleanup. */
  readonly timeoutMs?: number;
  readonly cancellationGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: ExecutionClock;
  /** Per-resource cleanup receipt budget inside the whole lifecycle budget. */
  readonly cleanupTimeoutMs?: number;
}

export type ExecutionCancellationContext = Pick<DeadlineTaskContext,
  "signal" | "remainingMs" | "throwIfCancelled" | "acknowledgeCancellation">;
