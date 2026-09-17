import type { CaseSpec, DesktopPlatform, FixtureDefinition, TestPlatform } from "@surfaceloom/core";
import type {
  EvidencePolicy,
  ReportBundleV3Result,
  ReportEnvironment,
  ReportHostV3,
  ReportedApp,
} from "@surfaceloom/reporter";

import type { CaseContext, ExecuteCaseOptions } from "./contracts.js";
import type { EvidenceCompleteness } from "./evidence/content.js";
import type { RequiredEvidenceRequirement } from "./evidence/required-policy.js";
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
}

export type CaseSurfaceV3 = BrowserSurfaceAuthor
  | NativeSurfaceAuthor<DesktopPlatform, SurfaceOwnership>;

export interface CaseContextV3 extends CaseContext {
  /** Returns only a runner-acquired author facade; identities/controllers stay hidden. */
  surface(surfaceId: string): CaseSurfaceV3;
  readonly evidence: CaseEvidenceV3;
}

export interface CaseDefinitionV3 {
  readonly spec: CaseSpec;
  readonly fixtures?: readonly FixtureDefinition<unknown>[];
  readonly run: (context: CaseContextV3) => void | Promise<void>;
}

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
  readonly evidencePolicy?: Partial<EvidencePolicy>;
  /** Runner-owned plan/environment/policy; Case authors never receive these controls. */
  readonly execution: Omit<ExecuteCaseOptions, "platform">;
  readonly stagingDirectory: string;
  readonly outputDirectory: string;
}

export interface RunCaseV3Result {
  readonly bundle: ReportBundleV3Result;
  readonly exitCode: 0 | 1;
}
