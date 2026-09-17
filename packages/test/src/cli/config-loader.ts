import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import type { TypeScriptCaseRuntime } from "../loader-contracts.js";
import { snapshotTypeScriptRuntime } from "../loader.js";
import type { ProjectDefinition } from "../project-contracts.js";
import { isProjectDefinition, requireProjectDefinition } from "../project.js";
import { plainRecord, safeErrorMessage, stringValue } from "../project-validation.js";

const configPattern = /\.(?:js|mjs|cjs)$/u;
const requireModule = createRequire(import.meta.url);

export interface LoadedProjectConfig {
  readonly configPath: string;
  readonly project: ProjectDefinition;
  readonly typescriptRuntime?: TypeScriptCaseRuntime;
}

export class ProjectConfigLoadError extends Error {
  readonly exitCode = 2 as const;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProjectConfigLoadError";
  }
}

/**
 * Loads only JavaScript config modules that Node can execute without a repository loader.
 * ESM configs default-export the project. Because this package is ESM-only, CommonJS
 * configs must export a native Promise resolving to { project, typescriptRuntime? }.
 * For example: module.exports = import("@surfaceloom/test").then(({ defineProject }) =>
 *   ({ project: defineProject({ cases: ["cases"] }) }));
 */
export async function loadProjectConfig(configPath: string,
  options: { readonly cwd?: string } = {}): Promise<LoadedProjectConfig> {
  try {
    const settings = plainRecord(options, "config loader options", ["cwd"]);
    const cwd = path.resolve(settings.cwd === undefined ? process.cwd()
      : stringValue(settings.cwd, "config loader cwd"));
    const requested = stringValue(configPath, "config path");
    const absolute = path.resolve(cwd, requested);
    if (!path.isAbsolute(requested)) assertWithin(cwd, absolute, "Config path escapes cwd.");
    if (!configPattern.test(path.basename(absolute))) {
      throw failure("unsupportedConfigModule", "Config module must be .js, .mjs, or .cjs.");
    }
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw failure("symbolicConfig", "Config module must not be a symbolic link.");
    if (!info.isFile()) throw failure("invalidConfig", "Config path is not a file.");
    const canonical = await realpath(absolute);
    if (!path.isAbsolute(requested)) assertWithin(await realpath(cwd), canonical,
      "Config module escapes cwd through its canonical path.");
    const commonjs = canonical.endsWith(".cjs")
      || (canonical.endsWith(".js") && await javascriptIsCommonJS(canonical));
    const loaded: unknown = commonjs
      ? await loadCommonJsConfig(canonical) : await import(pathToFileURL(canonical).href);
    const parsed = commonjs ? cjsPayload(loaded) : moduleShape(loaded);
    requireProjectDefinition(parsed.project);
    const runtime = parsed.typescriptRuntime === undefined ? undefined
      : snapshotTypeScriptRuntime(parsed.typescriptRuntime);
    // Preserve the caller's normalized lexical base; the loader separately verified canonical containment.
    return Object.freeze({ configPath: absolute, project: parsed.project,
      ...(runtime === undefined ? {} : { typescriptRuntime: runtime }) });
  } catch (error) {
    if (error instanceof ProjectConfigLoadError) throw error;
    throw failure("configLoadFailed", safeErrorMessage(error));
  }
}

async function loadCommonJsConfig(filePath: string): Promise<unknown> {
  const exported: unknown = requireModule(filePath);
  if (!types.isPromise(exported)) {
    throw failure("synchronousCommonJsConfig",
      "CommonJS config must export a Promise that resolves to { project, typescriptRuntime? }.");
  }
  return exported;
}

async function javascriptIsCommonJS(filePath: string): Promise<boolean> {
  let directory = path.dirname(filePath);
  while (true) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      return !(typeof parsed === "object" && parsed !== null
        && (parsed as Record<string, unknown>).type === "module");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function moduleShape(input: unknown): { project: ProjectDefinition; typescriptRuntime?: unknown } {
  const namespace = moduleRecord(input, "ESM config module", ["default", "typescriptRuntime", "module.exports"]);
  if (isProjectDefinition(namespace.default)) {
    if (namespace["module.exports"] !== undefined) {
      throw failure("ambiguousConfig", "Config module exposes both ESM and CommonJS shapes.");
    }
    return { project: namespace.default,
      ...(namespace.typescriptRuntime === undefined ? {} : { typescriptRuntime: namespace.typescriptRuntime }) };
  }
  if (namespace.typescriptRuntime !== undefined) {
    throw failure("ambiguousConfig", "A CommonJS config runtime must be inside module.exports.");
  }
  return cjsPayload(namespace.default);
}

function moduleRecord(input: unknown, label: string,
  allowed: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (input === null || typeof input !== "object") throw failure("invalidConfig", `${label} has no exports.`);
    const descriptors = Object.getOwnPropertyDescriptors(input) as Record<PropertyKey, PropertyDescriptor>;
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === Symbol.toStringTag) continue;
      if (typeof key !== "string" || !allowed.includes(key)) {
        throw failure("ambiguousConfig", `${label} contains unexpected exports.`);
      }
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) throw failure("configAccessor", `${label} exports must not be accessors.`);
      entries.push([key, descriptor.value]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } catch (error) {
    if (error instanceof ProjectConfigLoadError) throw error;
    throw failure("unreadableConfig", `${label} could not be inspected.`);
  }
}

function cjsPayload(input: unknown): { project: ProjectDefinition; typescriptRuntime?: unknown } {
  const payload = plainRecord(input, "CommonJS config export", ["project", "typescriptRuntime"]);
  if (!isProjectDefinition(payload.project)) {
    throw failure("unbrandedProject", "CommonJS config.project must come from defineProject().");
  }
  return { project: payload.project,
    ...(payload.typescriptRuntime === undefined ? {} : { typescriptRuntime: payload.typescriptRuntime }) };
}

function assertWithin(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw failure("configPathEscape", message);
  }
}

function failure(code: string, message: string): ProjectConfigLoadError {
  return new ProjectConfigLoadError(code, message);
}
