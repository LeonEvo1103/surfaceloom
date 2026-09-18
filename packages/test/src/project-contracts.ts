import type { TestPlatform } from "@surfaceloom/core";
import type { ReportedApp } from "@surfaceloom/reporter";
import type { CaseDefinitionV3, RunCaseV3Options } from "./runner-v3-contracts.js";

export type ProjectModuleFormat = "esm" | "commonjs";

export interface ProjectRunnerV3Context {
  readonly definition: CaseDefinitionV3;
  readonly rootDir: string;
  readonly platform: TestPlatform;
  readonly outputDirectory: string;
  readonly timeoutMs?: number;
  readonly run: Readonly<{
    id: string;
    title: string;
    app: ReportedApp;
  }>;
}

export interface ProjectRunnerV3Input {
  readonly version: "v3";
  /** Supplies the complete existing runCaseV3 options for the selected Case. */
  readonly options: (context: ProjectRunnerV3Context) =>
    RunCaseV3Options | Promise<RunCaseV3Options>;
}

export interface ProjectRunnerV3 {
  readonly version: "v3";
  readonly options: ProjectRunnerV3Input["options"];
}

export interface ProjectDefinitionInput {
  /** Relative to the config module directory. Defaults to '.'. */
  readonly rootDir?: string;
  /** Nonempty Case files/directories, relative to rootDir. */
  readonly cases: readonly string[];
  readonly platform?: TestPlatform;
  /** Relative to rootDir. */
  readonly outputDir?: string;
  readonly timeoutMs?: number;
  /** Required to load extension-neutral *.case.ts modules. */
  readonly typescript?: { readonly moduleFormat: ProjectModuleFormat };
  /** Omit for the compatible v2 suite path. v3 is config-only and explicit. */
  readonly runner?: ProjectRunnerV3Input;
}

export interface ProjectDefinition {
  readonly rootDir: string;
  readonly cases: readonly string[];
  readonly platform?: TestPlatform;
  readonly outputDir?: string;
  readonly timeoutMs?: number;
  readonly typescript?: Readonly<{ moduleFormat: ProjectModuleFormat }>;
  readonly runner?: ProjectRunnerV3;
}

export interface ProjectInvocationOverrides {
  /** Replaces, rather than appends to, configured sources. Relative to cwd. */
  readonly sources?: readonly string[];
  readonly platform?: TestPlatform;
  /** Relative to cwd. */
  readonly outputDir?: string;
  readonly timeoutMs?: number;
}

export interface ResolveProjectOptions {
  /** Config module path; relative paths use cwd. It anchors configured paths. */
  readonly configPath: string;
  readonly cwd?: string;
  readonly overrides?: ProjectInvocationOverrides;
}

export interface ResolvedProject {
  readonly configPath: string;
  readonly rootDir: string;
  readonly sources: readonly string[];
  readonly platform?: TestPlatform;
  readonly outputDir?: string;
  readonly timeoutMs?: number;
  readonly typescript?: Readonly<{ moduleFormat: ProjectModuleFormat }>;
  readonly runner?: ProjectRunnerV3;
}
