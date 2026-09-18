import type { RunnableCase } from "./cli/contracts.js";
import type { ProjectModuleFormat, ResolvedProject } from "./project-contracts.js";
import type { CaseDefinitionV3 } from "./runner-v3-contracts.js";

export type CaseModuleLanguage = "javascript" | "typescript";
export type CaseModuleFormat = ProjectModuleFormat | "node";

export interface CaseModuleLoadRequest {
  readonly filePath: string;
  readonly url: string;
  readonly projectRoot: string;
  readonly language: CaseModuleLanguage;
  /** 'node' means package-scope resolution for extension-neutral compiled *.js. */
  readonly format: CaseModuleFormat;
}

/** Supplied and versioned by the consuming project; SurfaceLoom never imports tsx or a repo tsconfig. */
export interface TypeScriptCaseRuntime {
  readonly id: string;
  load(request: CaseModuleLoadRequest): Promise<unknown>;
}

export interface ProjectCaseLoaderOptions {
  readonly typescriptRuntime?: TypeScriptCaseRuntime;
  /** Injectable compiled-JS boundary; defaults to native dynamic import. */
  readonly loadJavaScriptModule?: (request: CaseModuleLoadRequest) => Promise<unknown>;
}

/** Compatible public v2 loader result. */
export interface LoadedProjectCases {
  readonly project: ResolvedProject;
  readonly cases: readonly RunnableCase[];
}

export interface LoadedProjectCasesV3 {
  readonly project: ResolvedProject;
  readonly cases: readonly CaseDefinitionV3[];
}
