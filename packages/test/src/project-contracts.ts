import type { TestPlatform } from "@surfaceloom/core";

export type ProjectModuleFormat = "esm" | "commonjs";

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
}

export interface ProjectDefinition {
  readonly rootDir: string;
  readonly cases: readonly string[];
  readonly platform?: TestPlatform;
  readonly outputDir?: string;
  readonly timeoutMs?: number;
  readonly typescript?: Readonly<{ moduleFormat: ProjectModuleFormat }>;
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
}
