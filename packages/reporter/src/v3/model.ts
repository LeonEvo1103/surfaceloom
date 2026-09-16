import type { CaseSpec, TestPlatform } from "@surfaceloom/core";

import type {
  CaseExecutionResultInput,
  EvidencePolicy,
  ReportEnvironment,
  ReportSummary,
  ReportedApp,
  ReportedCaseExecutionResult,
  RunStatus,
} from "../model.js";

export const reportSchemaVersionV3 = "surfaceloom.report/v3" as const;

export type UnknownContextReason =
  | "notRecorded"
  | "unavailable"
  | "redacted"
  | "notApplicable";

export interface UnknownContext {
  readonly state: "unknown";
  readonly reason: UnknownContextReason;
  readonly detail?: string;
}

export interface KnownContext<T> {
  readonly state: "known";
  readonly value: T;
}

export type ContextValue<T> = KnownContext<T> | UnknownContext;

export type HostOperatingSystem = "macos" | "windows" | "linux";
export type SurfaceKind = "browser" | "desktop" | "system";

export interface ReportHostV3 {
  readonly id: string;
  readonly os: HostOperatingSystem;
  readonly name?: string;
  readonly osVersion?: string;
  readonly architecture?: string;
}

export interface ReportSurfaceV3 {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly hostId: ContextValue<string>;
  readonly name?: string;
  readonly capabilities?: readonly string[];
}

export type ReportProvenanceV3 =
  | { readonly kind: "native" }
  | {
      readonly kind: "imported-v2";
      readonly sourceSchemaVersion: "surfaceloom.report/v2";
      readonly sourcePlatform: TestPlatform;
      readonly limitations: readonly V2ImportLimitation[];
    };

export type V2ImportLimitation =
  | "hostNotRecorded"
  | "surfacesNotRecorded"
  | "attemptsNotRecorded";

export interface ReportRunV3 {
  readonly id: string;
  readonly title: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly app: ReportedApp;
  readonly environment?: ReportEnvironment;
  readonly provenance: ReportProvenanceV3;
  readonly hosts: ContextValue<readonly ReportHostV3[]>;
  readonly surfaces: ContextValue<readonly ReportSurfaceV3[]>;
}

export interface CaseAttemptV3Input {
  readonly id: string;
  readonly ordinal: number;
  /** Platform mappings actually used by this attempt; mixed-surface attempts may use more than one. */
  readonly executionPlatforms: readonly TestPlatform[];
  /** Host running the attempt coordinator; surfaces retain their own host facts. */
  readonly runnerHostId: ContextValue<string>;
  readonly surfaceIds: ContextValue<readonly string[]>;
  readonly result: CaseExecutionResultInput;
}

export interface ReportedCaseAttemptV3
  extends Omit<CaseAttemptV3Input, "result"> {
  readonly result: ReportedCaseExecutionResult;
}

export interface KnownAttemptsV3Input {
  readonly state: "known";
  readonly finalAttemptId: string;
  readonly items: readonly CaseAttemptV3Input[];
}

export interface ReportedKnownAttemptsV3 {
  readonly state: "known";
  readonly finalAttemptId: string;
  readonly items: readonly ReportedCaseAttemptV3[];
}

export interface UnknownAttemptsV3Input extends UnknownContext {
  /** Final Case result is retained without inventing an attempt boundary. */
  readonly result: CaseExecutionResultInput;
}

export interface ReportedUnknownAttemptsV3 extends UnknownContext {
  readonly result: ReportedCaseExecutionResult;
}

export type AttemptsV3Input = KnownAttemptsV3Input | UnknownAttemptsV3Input;
export type ReportedAttemptsV3 = ReportedKnownAttemptsV3 | ReportedUnknownAttemptsV3;

export interface CaseReportV3Input {
  readonly spec: CaseSpec;
  readonly attempts: AttemptsV3Input;
}

export interface ReportedTestCaseV3 {
  readonly spec: CaseSpec;
  readonly attempts: ReportedAttemptsV3;
}

export interface ReportBundleV3Input {
  readonly run: ReportRunV3;
  readonly tests: readonly CaseReportV3Input[];
}

export interface ReportSummaryV3 extends ReportSummary {
  readonly attempts: number;
  readonly casesWithUnknownAttempts: number;
}

export interface TestRunReportV3 {
  readonly schemaVersion: typeof reportSchemaVersionV3;
  readonly run: ReportRunV3;
  readonly status: RunStatus;
  readonly summary: ReportSummaryV3;
  readonly evidencePolicy: EvidencePolicy;
  readonly tests: readonly ReportedTestCaseV3[];
}

export interface ReportBundleV3Result {
  readonly directory: string;
  readonly completionMarkerPath: string;
  readonly reportPath: string;
  readonly htmlPath: string;
  readonly aiReviewPath: string;
  readonly report: TestRunReportV3;
}
