import { performance } from "node:perf_hooks";
import type { NormalizedCaseReportInput, ReportRunInput } from "@surfaceloom/reporter";
import { defineCase } from "../definition.js";
import { executeCase } from "../execute.js";
import { ExecutionPolicyError } from "../plan-errors.js";
import { createSuiteReport, writeSuiteReport } from "../report/suite-report.js";
import type {
  CaseModuleEntry,
  CaseSelection,
  CaseSuiteExecution,
  CaseSuiteRun,
  ExecuteCaseSuiteOptions,
  RunnableCase,
} from "./contracts.js";

/** Embedded sequential runner used by the CLI. Every runnable Case enters executeCase. */
export async function executeCaseSuite(
  entries: readonly CaseModuleEntry[],
  options: ExecuteCaseSuiteOptions,
): Promise<CaseSuiteExecution> {
  const normalized = normalizeEntries(entries);
  const selected = selectCases(normalized, options.selection, options.platform);
  if (selected.length === 0) throw new Error("No Cases matched the requested selection.");
  const now = options.now ?? (() => new Date());
  const initialStartedAt = now().toISOString();
  const tests: NormalizedCaseReportInput[] = [];
  for (const item of selected) {
    tests.push(await executeOne(item, options));
  }
  const runStartedAt = startTimestamp(initialStartedAt, tests);
  const runFinishedAt = finishTimestamp(now(), tests);
  const run: ReportRunInput = Object.freeze({
    ...options.run,
    platform: options.platform,
    startedAt: runStartedAt,
    finishedAt: runFinishedAt,
  });
  const report = createSuiteReport(run, tests);
  return Object.freeze({ selected, report });
}

export async function runCaseSuite(
  entries: readonly CaseModuleEntry[],
  options: ExecuteCaseSuiteOptions,
  outputDirectory: string,
): Promise<CaseSuiteRun> {
  const execution = await executeCaseSuite(entries, options);
  const report = await writeSuiteReport(execution.report, outputDirectory);
  return Object.freeze({ selected: execution.selected, report });
}

function normalizeEntries(entries: readonly CaseModuleEntry[]): readonly RunnableCase[] {
  const seen = new Set<string>();
  return Object.freeze(entries.map((entry) => {
    const runnable = isRunnable(entry) ? entry : { definition: entry };
    const definition = defineCase(runnable.definition);
    if (seen.has(definition.spec.id)) throw new Error(`Duplicate Case id: ${definition.spec.id}.`);
    seen.add(definition.spec.id);
    return Object.freeze({
      definition,
      ...(runnable.options === undefined ? {} : { options: Object.freeze({ ...runnable.options }) }),
      ...(runnable.sourcePath === undefined ? {} : { sourcePath: runnable.sourcePath }),
    });
  }));
}

function selectCases(
  entries: readonly RunnableCase[],
  selection: CaseSelection | undefined,
  platform: ExecuteCaseSuiteOptions["platform"],
): readonly RunnableCase[] {
  const ids = selection?.ids === undefined ? undefined : new Set(selection.ids);
  if (ids?.size === 0) throw new Error("Case id selection must not be empty.");
  const filters = selection?.filters;
  if (filters?.some((filter) => filter.length === 0)) throw new Error("Case filters must not be empty.");
  const requested = entries.filter(({ definition }) => {
    if (ids !== undefined && !ids.has(definition.spec.id)) return false;
    if (filters === undefined || filters.length === 0) return true;
    const text = [definition.spec.id, definition.spec.suite.name, definition.spec.name];
    return filters.some((filter) => text.some((field) => field.includes(filter)));
  });
  if (ids !== undefined) {
    const missing = [...ids].filter((id) => !entries.some((entry) => entry.definition.spec.id === id));
    if (missing.length > 0) throw new Error(`Unknown Case ids: ${missing.join(", ")}.`);
  }
  const unsupported = requested.filter((entry) => !entry.definition.spec.platforms.includes(platform));
  const hasExplicitSelection = ids !== undefined || (filters !== undefined && filters.length > 0);
  if (hasExplicitSelection && unsupported.length > 0) {
    throw new Error(`Cases do not support platform ${platform}: ${unsupported
      .map((entry) => entry.definition.spec.id).join(", ")}.`);
  }
  const selected = requested.filter((entry) => entry.definition.spec.platforms.includes(platform));
  return Object.freeze(selected);
}

async function executeOne(
  item: RunnableCase,
  suite: ExecuteCaseSuiteOptions,
): Promise<NormalizedCaseReportInput> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    return await executeCase(item.definition, {
      ...suite.defaults,
      ...item.options,
      platform: suite.platform,
    });
  } catch (error) {
    const durationMs = Math.max(0, performance.now() - started);
    return policyResult(item, startedAt, durationMs, error)
      ?? failedRunnerResult(item, startedAt, durationMs, error);
  }
}

function policyResult(
  item: RunnableCase,
  startedAt: string,
  durationMs: number,
  error: unknown,
): NormalizedCaseReportInput | undefined {
  if (!(error instanceof ExecutionPolicyError)) return undefined;
  const unsupported = new Set([
    "hostUnsupported", "missingSurface", "surfaceKindMismatch", "missingCapability",
  ]).has(error.code);
  const denied = new Set([
    "effectLimitExceeded", "undeclaredEffect", "resourceDenied", "operationDenied",
    "boundaryDenied", "externalEffectDenied", "securitySensitiveDenied", "unknownRecoveryDenied",
  ]).has(error.code);
  if (!unsupported && !denied) return undefined;
  const status = unsupported ? "unsupported" as const : "skipped" as const;
  const reason = unsupported
    ? `当前运行环境不支持此 Case（${error.code}）。`
    : `当前执行策略未授权此 Case（${error.code}）。`;
  return Object.freeze({
    spec: item.definition.spec,
    result: Object.freeze({ status, startedAt, durationMs, steps: Object.freeze([]), reason }),
  });
}

function failedRunnerResult(
  item: RunnableCase,
  startedAt: string,
  durationMs: number,
  error: unknown,
): NormalizedCaseReportInput {
  const message = safeErrorMessage(error);
  return Object.freeze({
    spec: item.definition.spec,
    result: Object.freeze({
      status: "failed",
      startedAt,
      durationMs,
      steps: Object.freeze([Object.freeze({
        id: "runner.execute",
        title: "执行 Case 内核",
        status: "failed",
        durationMs,
        diagnostic: message,
      })]),
      error: Object.freeze({ category: "runner", message }),
    }),
  });
}

function finishTimestamp(now: Date, tests: readonly NormalizedCaseReportInput[]): string {
  const lastResult = Math.max(...tests.map((test) =>
    Date.parse(test.result.startedAt) + Math.ceil(test.result.durationMs)));
  return new Date(Math.max(now.getTime(), lastResult)).toISOString();
}

function startTimestamp(initial: string, tests: readonly NormalizedCaseReportInput[]): string {
  const firstResult = Math.min(...tests.map((test) => Date.parse(test.result.startedAt)));
  return new Date(Math.min(Date.parse(initial), firstResult)).toISOString();
}

function safeErrorMessage(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null && "message" in error) {
      const message: unknown = error.message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    if (typeof error === "string" && error.length > 0) return error;
  } catch {
    return "Case execution failed with an unreadable error.";
  }
  return "Case execution failed with a non-Error value.";
}

function isRunnable(entry: CaseModuleEntry): entry is RunnableCase {
  return typeof entry === "object" && entry !== null && "definition" in entry;
}
