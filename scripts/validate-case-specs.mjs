#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateCaseSpecSources } from "./lib/case-spec-catalog.mjs";
import { findSourceTreeFiles } from "./lib/source-tree-files.mjs";

export {
  parseCaseSpecSidecar,
  validateCaseSpecSources,
} from "./lib/case-spec-catalog.mjs";
export {
  extractSwiftTestDisplayNames,
  scanSwiftTestDisplayNames,
} from "./lib/swift-test-display-names.mjs";
export {
  extractCSharpStaticStringAttributeNames,
  scanCSharpStaticStringAttributes,
} from "./lib/csharp-static-string-attributes.mjs";

/** Pure CLI argument parsing; path resolution remains in the I/O layer. */
export function parseCaseSpecCliArguments(argv) {
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) {
    throw new TypeError("CLI arguments must be an array of strings.");
  }
  if (argv.includes("--help") || argv.includes("-h")) return Object.freeze({ help: true });

  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    if (!["--spec-dir", "--swift-dir", "--csharp-dir", "--csharp-case-attribute"].includes(flag)) {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}\n${usage()}`);
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || value.length === 0 || (equals === -1 && value.startsWith("--"))) {
      throw new Error(`${flag} requires a value.\n${usage()}`);
    }
    values.set(flag, value);
  }

  const specDir = values.get("--spec-dir");
  const swiftDir = values.get("--swift-dir");
  const csharpDir = values.get("--csharp-dir");
  const csharpCaseAttribute = values.get("--csharp-case-attribute");
  if (specDir === undefined) {
    throw new Error(`--spec-dir is required.\n${usage()}`);
  }
  if (swiftDir === undefined && csharpDir === undefined) {
    throw new Error(`At least one native source directory is required.\n${usage()}`);
  }
  if ((csharpDir === undefined) !== (csharpCaseAttribute === undefined)) {
    throw new Error(
      `--csharp-dir and --csharp-case-attribute must be provided together.\n${usage()}`,
    );
  }
  return Object.freeze({
    help: false,
    specDir,
    ...(swiftDir === undefined ? {} : { swiftDir }),
    ...(csharpDir === undefined ? {} : { csharpDir, csharpCaseAttribute }),
  });
}

/** Recursively reads all source trees, then delegates to the pure catalog validator. */
export async function validateCaseSpecDirectories({
  specDir,
  swiftDir,
  csharpDir,
  csharpCaseAttribute,
}) {
  const [specPaths, swiftPaths, csharpPaths] = await Promise.all([
    findSourceTreeFiles(
      path.resolve(specDir),
      (_, name) => name.endsWith(".case-spec.json"),
    ),
    swiftDir === undefined
      ? Promise.resolve([])
      : findSourceTreeFiles(path.resolve(swiftDir), (_, name) => name.endsWith(".swift")),
    csharpDir === undefined
      ? Promise.resolve([])
      : findSourceTreeFiles(path.resolve(csharpDir), (_, name) => name.endsWith(".cs")),
  ]);
  const [specFiles, swiftFiles, csharpFiles] = await Promise.all([
    readSourceFiles(specPaths),
    readSourceFiles(swiftPaths),
    readSourceFiles(csharpPaths),
  ]);
  return validateCaseSpecSources(
    specFiles,
    swiftFiles,
    csharpFiles,
    csharpCaseAttribute === undefined ? {} : { csharpCaseAttribute },
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCaseSpecCliArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await validateCaseSpecDirectories(options);
  const sourceSummaries = [];
  if (options.swiftDir !== undefined) {
    sourceSummaries.push(`${result.swiftTestCount} macOS Swift @Test display name(s)`);
  }
  if (options.csharpDir !== undefined) {
    sourceSummaries.push(
      `${result.csharpTestCount} Windows ${options.csharpCaseAttribute} attribute(s)`,
    );
  }
  process.stdout.write(
    `Validated ${result.specCount} CaseSpec sidecar(s): ${sourceSummaries.join(", ")}.\n`,
  );
}

async function readSourceFiles(paths) {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    contents: await readFile(filePath, "utf8"),
  })));
}

function usage() {
  return "Usage: node scripts/validate-case-specs.mjs --spec-dir <directory> [--swift-dir <directory>] [--csharp-dir <directory> --csharp-case-attribute <identifier>]";
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined
    && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`CaseSpec validation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
