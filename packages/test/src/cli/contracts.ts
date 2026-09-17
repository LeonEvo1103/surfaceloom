import type { TestPlatform } from "@surfaceloom/core";
import type { ReportEnvironment, ReportedApp } from "@surfaceloom/reporter";
import type { CaseDefinition, ExecuteCaseOptions } from "../contracts.js";
import type { SuiteReportSnapshot, WrittenSuiteReport } from "../report/contracts.js";

export type CaseExecutionOverrides = Omit<ExecuteCaseOptions, "platform">;

/** Optional per-Case kernel options carried by a discovered module. */
export interface RunnableCase {
  readonly definition: CaseDefinition;
  readonly options?: CaseExecutionOverrides;
  readonly sourcePath?: string;
}

export type CaseModuleEntry = CaseDefinition | RunnableCase;

export interface CaseModuleShape {
  /** A module must expose this named export, or the same payload as default. */
  readonly cases: readonly CaseModuleEntry[];
}

export interface CaseDiscoveryOptions {
  readonly loadModule?: (url: string) => Promise<unknown>;
}

export interface CaseSelection {
  /** Exact stable Case ids. */
  readonly ids?: readonly string[];
  /** Case-sensitive substrings matched against id, suite name, and Case name. */
  readonly filters?: readonly string[];
}

export interface SuiteRunIdentity {
  readonly id: string;
  readonly title: string;
  readonly app: ReportedApp;
  readonly environment?: ReportEnvironment;
}

export interface ExecuteCaseSuiteOptions {
  readonly platform: TestPlatform;
  readonly run: SuiteRunIdentity;
  readonly defaults?: CaseExecutionOverrides;
  readonly selection?: CaseSelection;
  /** Injectable wall clock for the enclosing run window. */
  readonly now?: () => Date;
}

export interface CaseSuiteExecution {
  readonly selected: readonly RunnableCase[];
  readonly report: SuiteReportSnapshot;
}

export interface CaseSuiteRun extends CaseSuiteExecution {
  readonly report: WrittenSuiteReport;
}

export interface CliIO {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}
