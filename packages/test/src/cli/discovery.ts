import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CaseDefinition } from "../contracts.js";
import { CaseRegistry, defineCase } from "../definition.js";
import type {
  CaseDiscoveryOptions,
  CaseExecutionOverrides,
  CaseModuleEntry,
  RunnableCase,
} from "./contracts.js";

const caseModulePattern = /\.case\.[cm]?js$/u;

/** Discover explicit files and runtime-loadable *.case.{js,mjs,cjs} below directories. */
export async function discoverCases(
  sources: readonly string[],
  options: CaseDiscoveryOptions = {},
): Promise<readonly RunnableCase[]> {
  if (sources.length === 0) throw new Error("At least one Case module source is required.");
  const paths = await discoverModulePaths(sources);
  if (paths.length === 0) throw new Error("No Case modules were discovered.");
  const load = options.loadModule ?? ((url: string) => import(url));
  const cases: RunnableCase[] = [];
  const ids = new Map<string, string>();
  for (const modulePath of paths) {
    const loaded: unknown = await load(pathToFileURL(modulePath).href);
    const entries = readModuleEntries(loaded, modulePath);
    for (const entry of entries) {
      const runnable = normalizeEntry(entry, modulePath);
      const previous = ids.get(runnable.definition.spec.id);
      if (previous !== undefined) {
        throw new Error(`Duplicate Case id ${runnable.definition.spec.id} in ${previous} and ${modulePath}.`);
      }
      ids.set(runnable.definition.spec.id, modulePath);
      cases.push(runnable);
    }
  }
  if (cases.length === 0) throw new Error("Discovered modules did not export any Cases.");
  return Object.freeze(cases);
}

async function discoverModulePaths(sources: readonly string[]): Promise<readonly string[]> {
  const found = new Set<string>();
  for (const source of sources) {
    const absolute = path.resolve(source);
    const info = await stat(absolute);
    if (info.isFile()) found.add(await realpath(absolute));
    else if (info.isDirectory()) await collectDirectory(absolute, found);
    else throw new Error(`Case source is neither a file nor directory: ${absolute}.`);
  }
  return Object.freeze([...found].sort(compareText));
}

async function collectDirectory(directory: string, found: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectDirectory(candidate, found);
    else if (entry.isFile() && caseModulePattern.test(entry.name)) {
      found.add(await realpath(candidate));
    }
  }
}

function readModuleEntries(moduleValue: unknown, modulePath: string): readonly CaseModuleEntry[] {
  if (!isRecord(moduleValue)) throw new Error(`Case module ${modulePath} has no exports.`);
  const payload = moduleValue.cases ?? moduleValue.default;
  if (payload instanceof CaseRegistry) return payload.list();
  if (!Array.isArray(payload)) {
    throw new Error(`Case module ${modulePath} must export a cases array or CaseRegistry.`);
  }
  return payload as readonly CaseModuleEntry[];
}

function normalizeEntry(entry: CaseModuleEntry, sourcePath: string): RunnableCase {
  if (isRunnableCase(entry)) {
    return Object.freeze({
      definition: defineCase(entry.definition),
      ...(entry.options === undefined ? {} : { options: snapshotOptions(entry.options) }),
      sourcePath,
    });
  }
  return Object.freeze({ definition: defineCase(entry), sourcePath });
}

function isRunnableCase(value: CaseModuleEntry): value is RunnableCase {
  return isRecord(value) && "definition" in value;
}

function snapshotOptions(options: CaseExecutionOverrides): CaseExecutionOverrides {
  return Object.freeze({ ...options });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
