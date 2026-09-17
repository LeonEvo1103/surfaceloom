import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverCases } from "./cli/discovery.js";
import type {
  CaseModuleFormat, CaseModuleLoadRequest, LoadedProjectCases,
  ProjectCaseLoaderOptions, TypeScriptCaseRuntime,
} from "./loader-contracts.js";
import type { ResolvedProject } from "./project-contracts.js";
import { requireResolvedProject } from "./project.js";
import { plainRecord, safeErrorMessage, stringValue } from "./project-validation.js";

const casePattern = /\.case\.(?:[cm]?js|[cm]?ts)$/u;
const typescriptPattern = /\.[cm]?ts$/u;

export class ProjectLoadError extends Error {
  readonly exitCode = 2 as const;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProjectLoadError";
  }
}

/** Loads only Case modules; execution remains owned by the existing suite/kernel. */
export async function loadProjectCases(project: ResolvedProject,
  options: ProjectCaseLoaderOptions = {}): Promise<LoadedProjectCases> {
  try {
    requireResolvedProject(project);
    const loader = snapshotLoaderOptions(options);
    const modules = await caseModulePaths(project);
    const plans = modules.paths.map((filePath) => moduleRequest(project, modules.root, filePath));
    preflightTypeScript(plans, loader.typescriptRuntime);
    const byUrl = new Map(plans.map((plan) => [plan.url, plan]));
    const cases = await discoverCases(modules.paths, { loadModule: async (url) => {
      const request = byUrl.get(url);
      if (request === undefined) throw failure("modulePathMismatch", "Discovery requested an unknown module path.");
      if (request.language === "typescript") return loader.typescriptRuntime!.load(request);
      return loader.loadJavaScriptModule(request);
    } });
    return Object.freeze({ project, cases });
  } catch (error) {
    if (error instanceof ProjectLoadError) throw error;
    throw failure("projectLoadFailed", safeErrorMessage(error));
  }
}

async function caseModulePaths(project: ResolvedProject): Promise<{
  readonly root: string;
  readonly paths: readonly string[];
}> {
  const rootInfo = await lstat(project.rootDir);
  if (rootInfo.isSymbolicLink()) throw failure("symbolicLink", "Project root must not be a symbolic link.");
  if (!rootInfo.isDirectory()) throw failure("invalidRoot", "Project root is not a directory.");
  const root = await realpath(project.rootDir);
  const found = new Set<string>();
  for (const source of project.sources) {
    await collectSource(source, root, found, true);
  }
  if (found.size === 0) throw failure("noCases", "No Case modules were discovered.");
  return Object.freeze({ root, paths: Object.freeze([...found].sort(compareText)) });
}

async function collectSource(candidate: string, root: string, found: Set<string>, explicit: boolean): Promise<void> {
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) throw failure("symbolicLink", `Symbolic Case source is not allowed: ${candidate}.`);
  const canonical = await realpath(candidate);
  assertWithin(root, canonical);
  if (info.isFile()) {
    if (!casePattern.test(path.basename(candidate))) {
      if (explicit) throw failure("unsupportedModule", `Unsupported Case module: ${candidate}.`);
      return;
    }
    found.add(canonical);
    return;
  }
  if (!info.isDirectory()) throw failure("unsupportedSource", `Case source is not a file or directory: ${candidate}.`);
  const entries = await readdir(candidate, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const child = path.join(candidate, entry.name);
    if (entry.isSymbolicLink()) throw failure("symbolicLink", `Symbolic Case source is not allowed: ${child}.`);
    if (entry.isDirectory()) await collectSource(child, root, found, false);
    else if (entry.isFile() && casePattern.test(entry.name)) await collectSource(child, root, found, false);
  }
}

function moduleRequest(project: ResolvedProject, projectRoot: string,
  filePath: string): CaseModuleLoadRequest {
  const name = path.basename(filePath);
  const language = typescriptPattern.test(name) ? "typescript" as const : "javascript" as const;
  let format: CaseModuleFormat;
  if (/\.(?:mjs|mts)$/u.test(name)) format = "esm";
  else if (/\.(?:cjs|cts)$/u.test(name)) format = "commonjs";
  else if (name.endsWith(".js")) format = "node";
  else {
    const configured = project.typescript?.moduleFormat;
    if (configured === undefined) throw failure("ambiguousTypeScriptModule",
      `Extension-neutral TypeScript Case needs project.typescript.moduleFormat: ${filePath}.`);
    format = configured;
  }
  return Object.freeze({ filePath, url: pathToFileURL(filePath).href,
    projectRoot, language, format });
}

function preflightTypeScript(plans: readonly CaseModuleLoadRequest[],
  runtime: TypeScriptCaseRuntime | undefined): void {
  if (plans.some((plan) => plan.language === "typescript") && runtime === undefined) {
    throw failure("typescriptRuntimeRequired",
      "TypeScript Cases require a consuming-project TypeScript runtime.");
  }
}

function snapshotLoaderOptions(input: ProjectCaseLoaderOptions): {
  readonly typescriptRuntime?: TypeScriptCaseRuntime;
  readonly loadJavaScriptModule: (request: CaseModuleLoadRequest) => Promise<unknown>;
} {
  const value = plainRecord(input, "project loader options", ["typescriptRuntime", "loadJavaScriptModule"]);
  const loadJavaScriptModule = value.loadJavaScriptModule === undefined
    ? (request: CaseModuleLoadRequest) => import(request.url)
    : functionValue(value.loadJavaScriptModule, "loadJavaScriptModule");
  const typescriptRuntime = value.typescriptRuntime === undefined ? undefined
    : snapshotTypeScriptRuntime(value.typescriptRuntime);
  return Object.freeze({ loadJavaScriptModule,
    ...(typescriptRuntime === undefined ? {} : { typescriptRuntime }) });
}

/** @internal Shared with the config loader so exported runtime accessors are rejected once. */
export function snapshotTypeScriptRuntime(input: unknown): TypeScriptCaseRuntime {
  const value = plainRecord(input, "TypeScript runtime", ["id", "load"]);
  const id = stringValue(value.id, "TypeScript runtime id");
  if (id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(id)) {
    throw failure("invalidRuntime", "TypeScript runtime id must be a stable machine id.");
  }
  const load = functionValue(value.load, "TypeScript runtime load");
  return Object.freeze({ id, load: (request: CaseModuleLoadRequest) => load.call(input, request) });
}

function functionValue(input: unknown, label: string): (request: CaseModuleLoadRequest) => Promise<unknown> {
  if (typeof input !== "function") throw failure("invalidLoader", `${label} must be a function.`);
  return input as (request: CaseModuleLoadRequest) => Promise<unknown>;
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw failure("pathEscape", `Case source escapes the canonical project root: ${candidate}.`);
  }
}

function failure(code: string, message: string): ProjectLoadError {
  return new ProjectLoadError(code, message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
