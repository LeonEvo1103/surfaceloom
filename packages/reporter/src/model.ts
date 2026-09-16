import type {
  CaseSpec,
  TestPlatform,
  TraceValue,
} from "@surfaceloom/core";

export const reportSchemaVersion = "surfaceloom.report/v2" as const;

export type TestStatus =
  | "passed"
  | "failed"
  | "timedOut"
  | "skipped"
  | "unsupported";

export type RunStatus = "passed" | "failed" | "timedOut" | "incomplete";

export type ArtifactKind =
  | "screenshot"
  | "video"
  | "videoFrame"
  | "trace"
  | "agentLoop"
  | "accessibilityTree"
  | "log"
  | "diagnostics";

export type ArtifactPhase = "before" | "step" | "after" | "failure";
export type ReviewPriority = "primary" | "secondary";
export type CaptureStatus =
  | "captured"
  | "captureFailed"
  | "unsupported"
  | "notRequested";

export interface ReportEnvironment {
  readonly osName?: string;
  readonly osVersion?: string;
  readonly runnerName?: string;
  readonly runnerVersion?: string;
  readonly commit?: string;
  readonly branch?: string;
  readonly ci?: boolean;
}

export interface ReportedApp {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly build?: string;
}

export interface ReportRunInput {
  readonly id: string;
  readonly title: string;
  readonly platform: TestPlatform;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly app: ReportedApp;
  readonly environment?: ReportEnvironment;
}

export interface TestErrorSummary {
  readonly category: string;
  readonly message: string;
  readonly expected?: TraceValue;
  readonly actual?: TraceValue;
}

export interface TestStepResult {
  readonly id: string;
  readonly title: string;
  readonly status: TestStatus;
  readonly durationMs: number;
  readonly componentId?: string;
  readonly action?: string;
  readonly assertion?: string;
  readonly diagnostic?: string;
  /** Stable acceptance-criterion ids proven or checked by this step. */
  readonly criterionIds?: readonly string[];
}

export interface SourceArtifact {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly phase: ArtifactPhase;
  readonly title: string;
  readonly captureStatus: CaptureStatus;
  readonly sourcePath?: string;
  readonly contentType: string;
  readonly capturedAt: string;
  readonly reviewPriority?: ReviewPriority;
  readonly stepId?: string;
  readonly description?: string;
  readonly sensitive?: boolean;
  readonly durationMs?: number;
  readonly relatedArtifactIds?: readonly string[];
  readonly captureError?: string;
}

export interface ReportArtifact extends Omit<SourceArtifact, "sourcePath"> {
  readonly contentTrust: "untrusted";
  readonly relativePath?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
}

export interface CaseExecutionResultInput {
  readonly status: TestStatus;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: readonly TestStepResult[];
  readonly artifacts?: readonly SourceArtifact[];
  readonly error?: TestErrorSummary;
  /** Required for skipped/unsupported; execution facts never rewrite CaseSpec. */
  readonly reason?: string;
}

/**
 * Input shape emitted by report/v2 producers before CaseSpec gained an
 * explicit platform list. It is accepted only at the Reporter ingestion
 * boundary and is normalized conservatively to the current run platform.
 */
export type LegacyCaseSpecV2 = Omit<CaseSpec, "platforms">;

export type ReportCaseSpecInput = CaseSpec | LegacyCaseSpecV2;

export interface CaseReportInput {
  readonly spec: ReportCaseSpecInput;
  readonly result: CaseExecutionResultInput;
}

export interface NormalizedCaseReportInput {
  readonly spec: CaseSpec;
  readonly result: CaseExecutionResultInput;
}

export interface ReportedCaseExecutionResult
  extends Omit<CaseExecutionResultInput, "artifacts"> {
  readonly artifacts: readonly ReportArtifact[];
}

export interface ReportedTestCase {
  readonly spec: CaseSpec;
  readonly result: ReportedCaseExecutionResult;
}

export interface ReportSummary {
  readonly discovered: number;
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly skipped: number;
  readonly unsupported: number;
  readonly evidence: Readonly<Record<CaptureStatus, number>>;
}

export interface TestRunReport {
  readonly schemaVersion: typeof reportSchemaVersion;
  readonly run: ReportRunInput;
  readonly status: RunStatus;
  readonly summary: ReportSummary;
  readonly evidencePolicy: EvidencePolicy;
  readonly tests: readonly ReportedTestCase[];
}

export type RetentionMode = "off" | "on-failure" | "always";

export interface EvidencePolicy {
  readonly screenshots: RetentionMode;
  readonly video: RetentionMode;
  readonly trace: "off" | "always";
  readonly accessibilityTree: RetentionMode;
  readonly logs: "off" | "always";
}

export interface ReportBundleInput {
  readonly run: ReportRunInput;
  readonly tests: readonly CaseReportInput[];
}

/** Canonical input used internally and emitted in report/v2 output. */
export interface NormalizedReportBundleInput {
  readonly run: ReportRunInput;
  readonly tests: readonly NormalizedCaseReportInput[];
}

export interface ReportBundleResult {
  readonly directory: string;
  readonly completionMarkerPath: string;
  readonly reportPath: string;
  readonly htmlPath: string;
  readonly aiReviewPath: string;
  readonly report: TestRunReport;
}
