import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { testPlatforms, type TestPlatform } from "@surfaceloom/core";
import type {
  ProjectDefinition, ProjectDefinitionInput, ProjectInvocationOverrides,
  ProjectModuleFormat, ResolveProjectOptions, ResolvedProject,
} from "./project-contracts.js";
import {
  plainRecord, positiveInteger, ProjectConfigurationError, stringArray, stringValue,
} from "./project-validation.js";

export { ProjectConfigurationError } from "./project-validation.js";
const definitions = new WeakSet<object>();
const resolutions = new WeakSet<object>();

export function defineProject(input: ProjectDefinitionInput): ProjectDefinition {
  const value = plainRecord(input, "project", [
    "rootDir", "cases", "platform", "outputDir", "timeoutMs", "typescript",
  ]);
  const rootDir = configuredPath(value.rootDir ?? ".", "project.rootDir");
  const cases = configuredPaths(value.cases, "project.cases");
  const platform = optionalPlatform(value.platform, "project.platform");
  const outputDir = value.outputDir === undefined ? undefined
    : configuredPath(value.outputDir, "project.outputDir");
  const timeoutMs = value.timeoutMs === undefined ? undefined
    : positiveInteger(value.timeoutMs, "project.timeoutMs");
  const typescript = value.typescript === undefined ? undefined : typescriptOptions(value.typescript);
  const project: ProjectDefinition = Object.freeze({
    rootDir, cases,
    ...(platform === undefined ? {} : { platform }),
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(typescript === undefined ? {} : { typescript }),
  });
  definitions.add(project);
  return project;
}

/** Invocation values replace project values; configured paths and invocation paths have distinct bases. */
export function resolveProject(project: ProjectDefinition,
  options: ResolveProjectOptions): ResolvedProject {
  requireProjectDefinition(project);
  const settings = plainRecord(options, "project resolution", ["configPath", "cwd", "overrides"]);
  const cwd = path.resolve(settings.cwd === undefined ? process.cwd()
    : stringValue(settings.cwd, "resolution.cwd"));
  const configPath = path.resolve(cwd, stringValue(settings.configPath, "resolution.configPath"));
  const rootDir = path.resolve(path.dirname(configPath), project.rootDir);
  within(path.dirname(configPath), rootDir, "project.rootDir");
  const overrides = settings.overrides === undefined ? undefined : invocation(settings.overrides);
  const sourceValues = overrides?.sources ?? project.cases;
  const sourceBase = overrides?.sources === undefined ? rootDir : cwd;
  const sources = absolutePaths(sourceValues, sourceBase, rootDir, "Case source");
  const outputValue = overrides?.outputDir ?? project.outputDir;
  const outputBase = overrides?.outputDir === undefined ? rootDir : cwd;
  const outputDir = outputValue === undefined ? undefined
    : checkedAbsolute(outputValue, outputBase, rootDir, "output directory");
  const platform = overrides?.platform ?? project.platform;
  const timeoutMs = overrides?.timeoutMs ?? project.timeoutMs;
  const resolved: ResolvedProject = Object.freeze({
    configPath, rootDir, sources,
    ...(platform === undefined ? {} : { platform }),
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(project.typescript === undefined ? {} : { typescript: project.typescript }),
  });
  resolutions.add(resolved);
  return resolved;
}

/**
 * Rejects output paths whose currently existing project-relative ancestry is
 * symbolic or canonically outside the project root. This is a static check;
 * callers must still fail closed if the filesystem changes before a write.
 */
export async function preflightResolvedProject(project: ResolvedProject): Promise<void> {
  requireResolvedProject(project);
  if (project.outputDir === undefined) return;

  const rootInfo = await pathInfo(project.rootDir, "project root");
  if (rootInfo.isSymbolicLink()) {
    throw new ProjectConfigurationError("pathSymlink", "Project root must not be a symbolic link.");
  }
  if (!rootInfo.isDirectory()) {
    throw new ProjectConfigurationError("invalidPath", "Project root must be a directory.");
  }
  const canonicalRoot = await realpath(project.rootDir);
  let nearestExisting = project.rootDir;
  const relative = path.relative(project.rootDir, project.outputDir);
  for (const segment of relative.split(path.sep).filter((entry) => entry.length > 0)) {
    const candidate = path.join(nearestExisting, segment);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (missingPath(error)) break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new ProjectConfigurationError("pathSymlink",
        "Output directory must not have an existing symbolic-link ancestor.");
    }
    if (!info.isDirectory()) {
      throw new ProjectConfigurationError("invalidPath",
        "Output directory ancestry must contain only directories.");
    }
    nearestExisting = candidate;
  }
  within(canonicalRoot, await realpath(nearestExisting), "output directory canonical ancestor");
}

/** @internal Config loaders use the same instance-local brand as resolveProject. */
export function requireProjectDefinition(project: ProjectDefinition): void {
  if (!definitions.has(project)) throw new ProjectConfigurationError("undefinedProject",
    "A project config must export a value returned by defineProject.");
}

/** @internal Avoids probing branded project fields while selecting ESM/CJS config shape. */
export function isProjectDefinition(value: unknown): value is ProjectDefinition {
  return typeof value === "object" && value !== null && definitions.has(value);
}

/** @internal Enforces that loaders consume the validated, frozen resolution. */
export function requireResolvedProject(project: ResolvedProject): void {
  if (!resolutions.has(project)) throw new ProjectConfigurationError("unresolvedProject",
    "Case loading requires a value returned by resolveProject.");
}

function invocation(input: unknown): ProjectInvocationOverrides {
  const value = plainRecord(input, "project overrides", ["sources", "platform", "outputDir", "timeoutMs"]);
  const sources = value.sources === undefined ? undefined : stringArray(value.sources, "overrides.sources");
  const platform = optionalPlatform(value.platform, "overrides.platform");
  const outputDir = value.outputDir === undefined ? undefined : stringValue(value.outputDir, "overrides.outputDir");
  const timeoutMs = value.timeoutMs === undefined ? undefined
    : positiveInteger(value.timeoutMs, "overrides.timeoutMs");
  return Object.freeze({
    ...(sources === undefined ? {} : { sources }),
    ...(platform === undefined ? {} : { platform }),
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function typescriptOptions(input: unknown): Readonly<{ moduleFormat: ProjectModuleFormat }> {
  const value = plainRecord(input, "project.typescript", ["moduleFormat"]);
  if (value.moduleFormat !== "esm" && value.moduleFormat !== "commonjs") {
    throw new ProjectConfigurationError("invalidModuleFormat",
      "project.typescript.moduleFormat must be 'esm' or 'commonjs'.");
  }
  return Object.freeze({ moduleFormat: value.moduleFormat });
}

function optionalPlatform(input: unknown, label: string): TestPlatform | undefined {
  if (input === undefined) return undefined;
  if (!testPlatforms.includes(input as TestPlatform)) {
    throw new ProjectConfigurationError("invalidPlatform", `${label} is not a supported platform.`);
  }
  return input as TestPlatform;
}

function configuredPaths(input: unknown, label: string): readonly string[] {
  const values = stringArray(input, label).map((value, index) => configuredPath(value, `${label}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new ProjectConfigurationError("duplicatePath", `${label} contains duplicate paths.`);
  }
  return Object.freeze(values);
}

function configuredPath(input: unknown, label: string): string {
  const value = stringValue(input, label);
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)
      || value.split(/[\\/]/u).includes("..")) {
    throw new ProjectConfigurationError("pathEscape", `${label} must stay relative to the project config.`);
  }
  return path.normalize(value);
}

function absolutePaths(values: readonly string[], base: string, root: string, label: string): readonly string[] {
  const result = values.map((value, index) => checkedAbsolute(value, base, root, `${label} ${index + 1}`));
  if (new Set(result).size !== result.length) {
    throw new ProjectConfigurationError("duplicatePath", `${label}s resolve to the same path.`);
  }
  return Object.freeze(result);
}

function checkedAbsolute(value: string, base: string, root: string, label: string): string {
  const absolute = path.resolve(base, value);
  within(root, absolute, label);
  return absolute;
}

function within(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectConfigurationError("pathEscape", `${label} escapes the project root.`);
  }
}

async function pathInfo(value: string, label: string) {
  try {
    return await lstat(value);
  } catch (error) {
    if (missingPath(error)) {
      throw new ProjectConfigurationError("missingPath", `${label} does not exist.`);
    }
    throw error;
  }
}

function missingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
