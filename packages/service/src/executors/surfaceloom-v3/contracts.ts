import type {
  CaseDefinitionV3, RunCaseV3Identity, RunCaseV3Options,
} from "@surfaceloom/test";

import type { ExecuteRequest } from "../../execution.js";
import type { ArtifactStore } from "../../stores/contracts.js";

export type SurfaceLoomV3RunIdentity = Omit<RunCaseV3Identity, "id">;
export type SurfaceLoomV3ExecutionOptions = Omit<RunCaseV3Options["execution"], "signal">;

export type SurfaceLoomV3CaseOptions = Omit<
  RunCaseV3Options,
  "run" | "execution" | "stagingDirectory" | "outputDirectory"
> & {
  readonly run: SurfaceLoomV3RunIdentity;
  readonly execution: SurfaceLoomV3ExecutionOptions;
};

export interface SurfaceLoomV3ResolveContext {
  readonly request: Readonly<ExecuteRequest>;
  readonly signal: AbortSignal;
}

export interface ResolvedSurfaceLoomV3Case {
  readonly definition: CaseDefinitionV3;
  readonly options: SurfaceLoomV3CaseOptions;
}

export interface RegisteredSurfaceLoomV3Test {
  readonly testId: string;
  readonly caseSpecId: string;
  readonly resolve: (
    context: SurfaceLoomV3ResolveContext,
  ) => ResolvedSurfaceLoomV3Case | Promise<ResolvedSurfaceLoomV3Case>;
}

export interface SurfaceLoomV3ExecutorOptions {
  readonly registrations: readonly RegisteredSurfaceLoomV3Test[];
  /** Absolute service-owned scratch root, separate from immutable workspaces. */
  readonly workRoot: string;
  readonly artifactStore: ArtifactStore;
  readonly maxBundleFiles?: number;
  readonly maxBundleBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly now?: () => Date;
}
