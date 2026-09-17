import { redactReportText } from "@surfaceloom/reporter";
import { jsonSnapshot } from "./json-data.js";

const issuedScopes = new WeakSet<object>();
const scopeAuthorities = new WeakMap<object, RunnerExecutionAuthority>();
const finalSelections = new WeakMap<object, ExecutionScope>();

export interface ExecutionScope {
  readonly reportRunId: string;
  readonly caseExecutionId: string;
  readonly attemptId: string;
  readonly ordinal: number;
  readonly runnerHostId: string;
}

export interface AttemptScopeInput {
  readonly caseExecutionId: string;
  readonly attemptId: string;
  readonly ordinal: number;
}

export interface FinalAttemptSelection {
  readonly caseExecutionId: string;
  readonly finalAttemptId: string;
  readonly ordinal: number;
}

/** Runner-owned authority: adapters can consume scopes but cannot mint one from raw metadata. */
export class RunnerExecutionAuthority {
  readonly #reportRunId: string;
  readonly #runnerHostId: string;
  readonly #caseExecutions = new Map<string, {
    readonly attempts: Map<string, ExecutionScope>;
    finalized: boolean;
  }>();

  constructor(input: { readonly reportRunId: string; readonly runnerHostId: string }) {
    jsonSnapshot(input, "runner execution authority");
    exactKeys(input, ["reportRunId", "runnerHostId"], "runner execution authority");
    this.#reportRunId = identifier("reportRunId", input.reportRunId);
    this.#runnerHostId = identifier("runnerHostId", input.runnerHostId);
  }

  issue(input: AttemptScopeInput): ExecutionScope {
    jsonSnapshot(input, "attempt scope input");
    exactKeys(input, ["caseExecutionId", "attemptId", "ordinal"], "attempt scope input");
    const caseExecutionId = identifier("caseExecutionId", input.caseExecutionId);
    const attemptId = identifier("attemptId", input.attemptId);
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) {
      throw new Error("Execution scope ordinal must be a positive integer.");
    }
    const execution = this.#caseExecutions.get(caseExecutionId) ?? {
      attempts: new Map<string, ExecutionScope>(), finalized: false,
    };
    if (execution.finalized) throw new Error("Case execution is already finalized.");
    if (execution.attempts.has(attemptId)) throw new Error("Duplicate execution scope.");
    if (input.ordinal !== execution.attempts.size + 1) {
      throw new Error("Runner attempt ordinals must be contiguous positive integers.");
    }
    const scope = Object.freeze({
      reportRunId: this.#reportRunId,
      caseExecutionId,
      attemptId,
      ordinal: input.ordinal,
      runnerHostId: this.#runnerHostId,
    });
    issuedScopes.add(scope);
    scopeAuthorities.set(scope, this);
    execution.attempts.set(attemptId, scope);
    this.#caseExecutions.set(caseExecutionId, execution);
    return scope;
  }

  finalize(caseExecutionIdInput: string, finalAttemptIdInput: string): FinalAttemptSelection {
    const caseExecutionId = identifier("caseExecutionId", caseExecutionIdInput);
    const finalAttemptId = identifier("finalAttemptId", finalAttemptIdInput);
    const execution = this.#caseExecutions.get(caseExecutionId);
    if (execution === undefined || execution.attempts.size === 0) {
      throw new Error("Cannot finalize an unknown case execution.");
    }
    if (execution.finalized) throw new Error("Case execution is already finalized.");
    const scope = execution.attempts.get(finalAttemptId);
    if (scope === undefined || scope.ordinal !== execution.attempts.size) {
      throw new Error("Final attempt must be the highest runner-issued ordinal.");
    }
    execution.finalized = true;
    const selection = Object.freeze({ caseExecutionId, finalAttemptId, ordinal: scope.ordinal });
    finalSelections.set(selection, scope);
    return selection;
  }
}

export function assertIssuedExecutionScope(scope: ExecutionScope): void {
  if (!issuedScopes.has(scope)) {
    throw new Error("Execution scope was not issued by the runner authority.");
  }
}

export function sameExecutionScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return left === right && issuedScopes.has(left);
}

export function assertSameExecutionAuthority(left: ExecutionScope, right: ExecutionScope): void {
  assertIssuedExecutionScope(left);
  assertIssuedExecutionScope(right);
  if (scopeAuthorities.get(left) !== scopeAuthorities.get(right)) {
    throw new Error("Execution scopes were not issued by the same runner authority.");
  }
}

export function finalAttemptScope(selection: FinalAttemptSelection): ExecutionScope {
  const scope = finalSelections.get(selection);
  if (scope === undefined) throw new Error("Final attempt selection was not runner-issued.");
  return scope;
}

export function identifier(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240
      || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
      || redactReportText(value) !== value) {
    throw new Error(`${label} must be a stable identifier.`);
  }
  return value;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unknown metadata.`);
  }
}
