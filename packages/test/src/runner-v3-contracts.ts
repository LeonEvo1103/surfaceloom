import type { CaseSpec, DesktopPlatform, FixtureDefinition, TestPlatform } from "@surfaceloom/core";
import type {
  EvidencePolicy,
  ReportBundleV3Result,
  ReportEnvironment,
  ReportHostV3,
  ReportedApp,
} from "@surfaceloom/reporter";

import type { CaseContext, ExecuteCaseOptions } from "./contracts.js";
import type { ExecutionGuiGate } from "./execution-gate.js";
import type { RunCaseV3FailureOrigin } from "./failure-origin.js";
import type { EvidenceCompleteness } from "./evidence/content.js";
import type { RequiredEvidenceRequirement } from "./evidence/required-policy.js";
import type { ResourceCleanupResult } from "./resources-contracts.js";
import type {
  JudgeCriterionV3,
  JudgeRunnerBindingV3,
  CaseImageEvidenceSubmissionV3,
} from "./judge/contracts.js";
import type {
  BrowserSurfaceAuthor,
  BrowserSurfaceBackendPort,
  BrowserSurfaceRequirement,
  NativeSurfaceAuthor,
  NativeSurfaceBackendPort,
  NativeSurfaceRequirement,
  SurfaceLease,
  SurfaceOwnership,
} from "./surfaces/contracts.js";

export interface CaseEvidenceSubmissionV3 {
  readonly id: string;
  readonly artifactId: string;
  readonly content: unknown;
  readonly completeness?: EvidenceCompleteness;
  readonly correlationId?: string;
}

export interface CaseEvidenceV3 {
  submit(input: CaseEvidenceSubmissionV3): void;
  /** Copies bounded image bytes into the current attempt; URLs and paths are not accepted. */
  submitImage(input: CaseImageEvidenceSubmissionV3): void;
}

export type CaseSurfaceV3 = BrowserSurfaceAuthor
  | NativeSurfaceAuthor<DesktopPlatform, SurfaceOwnership>;

export interface CaseContextV3 extends CaseContext {
  /** Returns only a runner-acquired author facade; identities/controllers stay hidden. */
  surface(surfaceId: string): CaseSurfaceV3;
  readonly evidence: CaseEvidenceV3;
}

export interface CaseDefinitionV3Input {
  readonly spec: CaseSpec;
  readonly fixtures?: readonly FixtureDefinition<unknown>[];
  /** Semantic checks are opt-in and must bind an existing acceptance criterion. */
  readonly judgeCriteria?: readonly JudgeCriterionV3[];
  readonly run: (context: CaseContextV3) => void | Promise<void>;
}

export type CaseDefinitionV3 = Omit<CaseDefinitionV3Input, "judgeCriteria">;

export interface BrowserRunnerSurfaceV3 {
  readonly kind: "browser";
  readonly requirement: BrowserSurfaceRequirement;
  readonly backend: BrowserSurfaceBackendPort;
  readonly lease?: SurfaceLease;
}

export interface NativeRunnerSurfaceV3 {
  readonly kind: "native";
  readonly requirement: NativeSurfaceRequirement<DesktopPlatform, SurfaceOwnership>;
  readonly backend: NativeSurfaceBackendPort<DesktopPlatform>;
}

export type RunnerSurfaceV3 = BrowserRunnerSurfaceV3 | NativeRunnerSurfaceV3;

export interface RunCaseV3Identity {
  readonly id: string;
  readonly title: string;
  readonly app: ReportedApp;
  readonly environment?: ReportEnvironment;
  readonly hosts: readonly ReportHostV3[];
}

export interface RunCaseV3Options {
  readonly platform: TestPlatform;
  readonly runnerHostId: string;
  readonly run: RunCaseV3Identity;
  readonly surfaces: readonly RunnerSurfaceV3[];
  readonly requiredEvidence?: readonly RequiredEvidenceRequirement[];
  /** Trusted host binding for @surfaceloom/llm-judge's judge() entry point. */
  readonly judge?: JudgeRunnerBindingV3;
  readonly evidencePolicy?: Partial<EvidencePolicy>;
  /** Held until surface/host/fixture cleanup is confirmed and runner publication finishes. */
  readonly executionGate?: ExecutionGuiGate;
  /** Runner-owned plan/environment/policy; Case authors never receive these controls. */
  readonly execution: Omit<ExecuteCaseOptions, "platform">;
  readonly stagingDirectory: string;
  readonly outputDirectory: string;
}

export interface RunCaseV3Result {
  readonly bundle: ReportBundleV3Result;
  readonly exitCode: 0 | 1;
  /** Structured failure truth for service embeddings; null means no classified failure. */
  readonly failureOrigin: RunCaseV3FailureOrigin;
  /** Terminal kernel cleanup truth retained for embedded service consumers. */
  readonly cleanup: ResourceCleanupResult;
}
