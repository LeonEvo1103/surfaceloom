import path from "node:path";
import { types } from "node:util";

import type { TestPlatform } from "@surfaceloom/core";
import type { ReportedApp } from "@surfaceloom/reporter";

import type { ProjectRunnerV3 } from "../project-contracts.js";
import type { CaseDefinitionV3, RunCaseV3Identity } from "../runner-v3-contracts.js";
import { runCaseV3 } from "../runner-v3.js";
import { snapshotRunCaseV3Options } from "../runner-v3-options.js";
import type { SuiteExitCode } from "../report/contracts.js";
import type { CaseSelection, CliIO } from "./contracts.js";

const nativePromise = Promise;
const nativePromisePrototype = Promise.prototype;
const nativePromiseThen = Promise.prototype.then;
const nativePromiseConstructor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor");
const nativePromiseSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
const nativePromiseThenDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "then");

export interface ExecuteConfiguredV3Options {
  readonly runner: ProjectRunnerV3;
  readonly cases: readonly CaseDefinitionV3[];
  readonly rootDir: string;
  readonly platform: TestPlatform;
  readonly outputDirectory: string;
  readonly timeoutMs?: number;
  readonly selection?: CaseSelection;
  readonly run: Readonly<{ id: string; title: string; app: ReportedApp }>;
}

/** Config dispatch only; execution and publication remain owned by the existing runCaseV3. */
export async function executeConfiguredV3(options: ExecuteConfiguredV3Options,
  io: CliIO): Promise<SuiteExitCode> {
  const definition = selectSingleCase(options.cases, options.selection, options.platform);
  const context = Object.freeze({ definition, rootDir: options.rootDir,
    platform: options.platform, outputDirectory: options.outputDirectory,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    run: Object.freeze({ ...options.run, app: Object.freeze({ ...options.run.app }) }),
  });
  const supplied = options.runner.options(context);
  const configured = types.isProxy(supplied) || !types.isPromise(supplied)
    ? snapshotRunCaseV3Options(supplied)
    : await snapshotNativePromise(supplied);
  assertOwnedCliFields(configured, context);
  const execution = options.timeoutMs === undefined ? configured.execution
    : Object.freeze({ ...configured.execution, timeoutMs: options.timeoutMs });
  const result = await runCaseV3(definition, Object.freeze({ ...configured, execution }));
  const summary = result.bundle.report.summary;
  io.stdout.write([
    `Report: ${result.bundle.reportPath}`,
    `Cases: ${summary.discovered}; passed=${summary.passed}; failed=${summary.failed}; timedOut=${summary.timedOut}; unsupported=${summary.unsupported}; skipped=${summary.skipped}`,
    `Status: ${result.bundle.report.status}`,
    "",
  ].join("\n"));
  return result.exitCode;
}

/** Never performs generic thenable assimilation before the v3 descriptor snapshot. */
function snapshotNativePromise(input: Promise<unknown>): Promise<ReturnType<
  typeof snapshotRunCaseV3Options>> {
  if (Object.getPrototypeOf(input) !== nativePromisePrototype) {
    throw new Error("V3 project options only accept an exact native Promise, not a Promise subclass.");
  }
  const own = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(own);
  if (ownKeys.includes("then") || ownKeys.includes("constructor")) {
    throw new Error("V3 project options Promise must not override then or constructor.");
  }
  if (!sameDescriptor(Object.getOwnPropertyDescriptor(nativePromisePrototype, "constructor"),
    nativePromiseConstructor)
      || !sameDescriptor(Object.getOwnPropertyDescriptor(nativePromisePrototype, "then"),
        nativePromiseThenDescriptor)
      || !sameDescriptor(Object.getOwnPropertyDescriptor(nativePromise, Symbol.species),
        nativePromiseSpecies)) {
    throw new Error("V3 project options Promise intrinsics were modified.");
  }
  return new nativePromise((resolve, reject) => {
    Reflect.apply(nativePromiseThen, input, [
      (value: unknown) => {
        try { resolve(snapshotRunCaseV3Options(value)); }
        catch (error) { reject(error); }
      },
      reject,
    ]);
  });
}

function sameDescriptor(left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.configurable === right.configurable && left.enumerable === right.enumerable
    && left.writable === right.writable && left.value === right.value
    && left.get === right.get && left.set === right.set;
}

function selectSingleCase(cases: readonly CaseDefinitionV3[], selection: CaseSelection | undefined,
  platform: TestPlatform): CaseDefinitionV3 {
  const ids = selection?.ids === undefined ? undefined : new Set(selection.ids);
  const filters = selection?.filters;
  if (ids?.size === 0) throw new Error("Case id selection must not be empty.");
  if (filters?.some((filter) => filter.length === 0)) throw new Error("Case filters must not be empty.");
  if (ids !== undefined) {
    const missing = [...ids].filter((id) => !cases.some((item) => item.spec.id === id));
    if (missing.length > 0) throw new Error(`Unknown Case ids: ${missing.join(", ")}.`);
  }
  const requested = cases.filter((definition) => {
    if (ids !== undefined && !ids.has(definition.spec.id)) return false;
    if (filters === undefined || filters.length === 0) return true;
    return filters.some((filter) => [definition.spec.id, definition.spec.suite.name,
      definition.spec.name].some((field) => field.includes(filter)));
  });
  const explicit = ids !== undefined || (filters !== undefined && filters.length > 0);
  const unsupported = requested.filter((definition) => !definition.spec.platforms.includes(platform));
  if (explicit && unsupported.length > 0) {
    throw new Error(`Cases do not support platform ${platform}: ${unsupported
      .map((definition) => definition.spec.id).join(", ")}.`);
  }
  const selected = requested.filter((definition) => definition.spec.platforms.includes(platform));
  if (selected.length !== 1) {
    throw new Error(selected.length === 0
      ? "No v3 Case matched the requested selection."
      : "V3 CLI currently requires exactly one selected Case; use --case-id or --filter.");
  }
  return selected[0]!;
}

function assertOwnedCliFields(configured: ReturnType<typeof snapshotRunCaseV3Options>,
  context: Readonly<{ platform: TestPlatform; outputDirectory: string;
    run: Readonly<{ id: string; title: string; app: ReportedApp }> }>): void {
  if (configured.platform !== context.platform) {
    throw new Error("V3 project options platform must match the resolved project platform.");
  }
  if (configured.outputDirectory !== path.resolve(context.outputDirectory)) {
    throw new Error("V3 project options outputDirectory must match the resolved project output.");
  }
  const run: RunCaseV3Identity = configured.run;
  if (run.id !== context.run.id || run.title !== context.run.title
      || !sameApp(run.app, context.run.app)) {
    throw new Error("V3 project options run id, title, and app must match the CLI run identity.");
  }
}

function sameApp(left: ReportedApp, right: ReportedApp): boolean {
  return left.id === right.id && left.name === right.name
    && left.version === right.version && left.build === right.build;
}
