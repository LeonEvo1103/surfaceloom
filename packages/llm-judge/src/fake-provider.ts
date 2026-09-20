import {
  type JudgeProvider,
  type JudgeProviderContext,
  JudgeProviderError,
  type JudgeRequest,
  type ProviderFailureKind,
} from "./contracts.js";
import { FAKE_DATA_BUDGET, sanitizeUntrusted } from "./validation-primitives.js";

const FAKE_METADATA = Object.freeze({ provider: "fake", model: "deterministic-script-v1" });

export interface FakeRequestExpectation {
  readonly serviceRunId?: string;
  readonly rubricVersion?: string;
  readonly question?: string;
  readonly evidenceIds?: readonly string[];
}

interface FakeStepBase {
  readonly expect?: FakeRequestExpectation;
}

export interface FakeReturnStep extends FakeStepBase {
  readonly kind: "return";
  readonly output: unknown;
}

export interface FakeThrowStep extends FakeStepBase {
  readonly kind: "throw";
  readonly failureKind: Exclude<ProviderFailureKind, "aborted" | "deadlineExceeded" | "invalidResponse">;
  readonly message: string;
  readonly retryable: boolean;
}

export interface FakeWaitForAbortStep extends FakeStepBase {
  readonly kind: "waitForAbort";
}

export type FakeJudgeStep = FakeReturnStep | FakeThrowStep | FakeWaitForAbortStep;

function clone<T>(value: T, path: string): T {
  return sanitizeUntrusted(value, path, FAKE_DATA_BUDGET) as T;
}

function bindFakeProvenance(output: unknown): unknown {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return output;
  return sanitizeUntrusted(
    { ...(output as Record<string, unknown>), providerMetadata: FAKE_METADATA },
    "fake.output",
    FAKE_DATA_BUDGET,
  );
}

function assertExpectation(request: JudgeRequest, expectation: FakeRequestExpectation | undefined): void {
  if (expectation === undefined) return;
  const mismatches: string[] = [];
  if (expectation.serviceRunId !== undefined && expectation.serviceRunId !== request.serviceRunId) {
    mismatches.push("serviceRunId");
  }
  if (expectation.rubricVersion !== undefined && expectation.rubricVersion !== request.rubricVersion) {
    mismatches.push("rubricVersion");
  }
  if (expectation.question !== undefined && expectation.question !== request.question) mismatches.push("question");
  if (expectation.evidenceIds !== undefined) {
    const actual = request.evidence.map((item) => item.evidenceId);
    if (actual.length !== expectation.evidenceIds.length
      || actual.some((id, index) => id !== expectation.evidenceIds?.[index])) {
      mismatches.push("evidenceIds");
    }
  }
  if (mismatches.length > 0) {
    throw new JudgeProviderError("provider", `Fake request mismatch: ${mismatches.join(", ")}`, false);
  }
}

/** A FIFO fake. The script and returned values are cloned to prevent mutation-based drift. */
export class FakeJudgeProvider implements JudgeProvider {
  readonly name = "fake";
  readonly #script: readonly FakeJudgeStep[];
  readonly #calls: JudgeRequest[] = [];
  #cursor = 0;

  constructor(script: readonly FakeJudgeStep[]) {
    this.#script = clone(script, "fake.script");
  }

  get calls(): readonly JudgeRequest[] {
    return clone(this.#calls, "fake.calls");
  }

  reset(): void {
    this.#cursor = 0;
    this.#calls.length = 0;
  }

  async judge(request: JudgeRequest, context: JudgeProviderContext): Promise<unknown> {
    const step = this.#script[this.#cursor];
    this.#cursor += 1;
    this.#calls.push(clone(request, "fake.request"));
    if (step === undefined) throw new JudgeProviderError("provider", "Fake script exhausted", false);
    assertExpectation(request, step.expect);
    if (step.kind === "return") return bindFakeProvenance(clone(step.output, "fake.output"));
    if (step.kind === "throw") {
      throw new JudgeProviderError(
        step.failureKind,
        step.message,
        step.retryable,
        FAKE_METADATA,
      );
    }
    return await new Promise<never>((_resolve, reject) => {
      if (context.signal.aborted) {
        reject(context.signal.reason ?? new Error("Fake provider aborted"));
        return;
      }
      context.signal.addEventListener(
        "abort",
        () => reject(context.signal.reason ?? new Error("Fake provider aborted")),
        { once: true },
      );
    });
  }
}
