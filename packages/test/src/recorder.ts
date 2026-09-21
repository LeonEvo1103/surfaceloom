import type { CaseSpec } from "@surfaceloom/core";
import type { TestErrorSummary, TestStepResult } from "@surfaceloom/reporter";
import type { CaseStep } from "./contracts.js";
import { assertIdentifier } from "./definition.js";
import { errorDiagnostic, errorSummary } from "./errors.js";
import {
  mergeFailureOrigins, recordedFailureOrigin, type RunCaseV3FailureOrigin,
} from "./failure-origin.js";

export class ExecutionRecorder {
  readonly #steps: TestStepResult[] = [];
  readonly #ids = new Set<string>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #seenFailures = new Set<unknown>();
  readonly #criteria: ReadonlyMap<string, string>;
  #sequence = 0;
  #open = true;
  #error: TestErrorSummary | undefined;
  #failureOrigin: RunCaseV3FailureOrigin = null;

  constructor(spec: CaseSpec) {
    this.#criteria = new Map(spec.acceptanceCriteria.map(({ id, text }) => [id, text]));
  }

  get error(): TestErrorSummary | undefined { return this.#error; }
  get failureOrigin(): RunCaseV3FailureOrigin { return this.#failureOrigin; }

  assertOpen(): void {
    if (!this.#open) throw new Error("Case execution is no longer accepting work.");
  }

  step<T>(step: CaseStep, body: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    let checked: CaseStep;
    try {
      checked = this.validateStep(step);
      if (typeof body !== "function") throw new Error("A step needs a callback.");
    } catch (error) {
      this.failure("authoring", error);
      return this.track(Promise.reject(error));
    }
    return this.track(this.record(checked, "step", body));
  }

  criterion<T>(id: string, check: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    const title = this.#criteria.get(id);
    if (title === undefined) {
      const error = new Error(`Unknown acceptance criterion: ${id}.`);
      this.failure("authoring", error);
      return this.track(Promise.reject(error));
    }
    return this.track(this.record({ id: this.nextId("criterion"), title, criterionIds: Object.freeze([id]) },
      "criterion", check));
  }

  stage<T>(phase: string, title: string, body: () => T | Promise<T>): Promise<T> {
    return this.record({ id: this.nextId(phase), title }, phase, body);
  }

  failure(phase: string, error: unknown): void {
    if (this.#seenFailures.has(error)) return;
    this.capture(phase, error);
    this.#steps.push(Object.freeze({
      id: this.nextId(phase), title: phase, status: "failed", durationMs: 0,
      diagnostic: errorDiagnostic(phase, error),
    }));
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    this.#open = false;
  }

  checkCoverage(): void {
    if (this.#error !== undefined) return;
    const covered = new Set(this.#steps.flatMap((step) =>
      step.status === "passed" ? step.criterionIds ?? [] : []));
    const missing = [...this.#criteria.keys()].filter((id) => !covered.has(id));
    if (missing.length > 0) {
      this.failure("acceptanceCriteria", new Error(`Unverified acceptance criteria: ${missing.join(", ")}.`));
    }
  }

  snapshot(): readonly TestStepResult[] { return Object.freeze([...this.#steps]); }

  private async record<T>(step: CaseStep, phase: string, body: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    const index = this.#steps.length;
    this.#steps.push({ ...step, status: "failed", durationMs: 0 });
    try {
      const value = await body();
      this.#steps[index] = Object.freeze({ ...step, status: "passed", durationMs: elapsed(started) });
      return value;
    } catch (error) {
      this.capture(phase, error, (step.criterionIds?.length ?? 0) > 0);
      this.#steps[index] = Object.freeze({ ...step, status: "failed", durationMs: elapsed(started),
        diagnostic: errorDiagnostic(phase, error) });
      throw error;
    }
  }

  private capture(phase: string, error: unknown, criterionLinked = false): void {
    this.#failureOrigin = mergeFailureOrigins(this.#failureOrigin,
      recordedFailureOrigin(phase, error, criterionLinked));
    this.#error ??= errorSummary(phase, error);
    this.#seenFailures.add(error);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    // Observe ignored rejections while preserving the promise returned to the author.
    void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise));
    return promise;
  }

  private nextId(phase: string): string { return `kernel.${phase}.${++this.#sequence}`; }

  private validateStep(step: CaseStep): CaseStep {
    assertIdentifier(step.id);
    if (step.id.startsWith("kernel.")) throw new Error("Step ids may not use the kernel. prefix.");
    if (this.#ids.has(step.id)) throw new Error(`Duplicate step id: ${step.id}.`);
    if (typeof step.title !== "string" || step.title.trim().length === 0) {
      throw new Error("A step needs a nonempty title.");
    }
    const criterionIds = step.criterionIds ?? [];
    if (!Array.isArray(criterionIds) || new Set(criterionIds).size !== criterionIds.length) {
      throw new Error("Step criterion ids must be a unique array.");
    }
    for (const id of criterionIds) {
      if (!this.#criteria.has(id)) throw new Error(`Unknown acceptance criterion: ${id}.`);
    }
    this.#ids.add(step.id);
    return Object.freeze({ id: step.id, title: step.title,
      criterionIds: Object.freeze([...criterionIds]) });
  }
}

export function elapsed(started: number): number {
  return Math.max(0, Math.floor(performance.now() - started));
}
