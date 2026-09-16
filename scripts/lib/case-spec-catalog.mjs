import { defineCaseSpec } from "../../packages/core/dist/index.js";

import { scanCSharpStaticStringAttributes } from "./csharp-static-string-attributes.mjs";
import { scanSwiftTestDisplayNames } from "./swift-test-display-names.mjs";

/** Parses one sidecar and applies Core's canonical CaseSpec validation. */
export function parseCaseSpecSidecar(contents, filePath = "<memory>.case-spec.json") {
  if (typeof contents !== "string") throw new TypeError("CaseSpec contents must be a string.");
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw contextualError(filePath, "contains invalid JSON", error);
  }
  try {
    return defineCaseSpec(value);
  } catch (error) {
    throw contextualError(filePath, "contains an invalid CaseSpec", error);
  }
}

/**
 * Pure validation over arrays of { filePath, contents }. A sidecar maps only to
 * the native source set declared in its platforms list, with a strict 1:1
 * sourceName mapping in each applicable platform.
 */
export function validateCaseSpecSources(
  specFiles,
  swiftFiles,
  csharpFiles = [],
  { csharpCaseAttribute = "SurfaceLoomCase" } = {},
) {
  assertSourceFiles("CaseSpec", specFiles);
  assertSourceFiles("Swift", swiftFiles);
  assertSourceFiles("C#", csharpFiles);
  if (specFiles.length === 0) throw new Error("No .case-spec.json files were discovered.");

  const specs = specFiles.map((file) => ({
    filePath: file.filePath,
    spec: parseCaseSpecSidecar(file.contents, file.filePath),
  }));
  const swiftTests = swiftFiles.flatMap((file) => {
    try {
      return scanSwiftTestDisplayNames(file.contents).map((test) => ({
        ...test,
        filePath: file.filePath,
      }));
    } catch (error) {
      throw contextualError(file.filePath, "cannot be scanned for @Test display names", error);
    }
  });
  const csharpTests = csharpFiles.flatMap((file) => {
    try {
      return scanCSharpStaticStringAttributes(file.contents, csharpCaseAttribute).map((test) => ({
        ...test,
        filePath: file.filePath,
      }));
    } catch (error) {
      throw contextualError(
        file.filePath,
        `cannot be scanned for ${csharpCaseAttribute} attributes`,
        error,
      );
    }
  });
  const problems = [];
  collectDuplicates(specs, (item) => item.spec.id, (item) => item.filePath, "CaseSpec id", problems);

  const namedSpecs = [];
  for (const item of specs) {
    if (item.spec.sourceName === undefined) {
      problems.push(`${item.filePath}: CaseSpec ${item.spec.id} must define sourceName for platform 1:1 mapping.`);
    } else namedSpecs.push(item);
  }
  const macosSpecs = namedSpecs.filter((item) => item.spec.platforms.includes("macos"));
  const windowsSpecs = namedSpecs.filter((item) => item.spec.platforms.includes("windows"));
  collectDuplicates(
    macosSpecs,
    (item) => item.spec.sourceName,
    (item) => item.filePath,
    "CaseSpec sourceName for macos",
    problems,
  );
  collectDuplicates(
    windowsSpecs,
    (item) => item.spec.sourceName,
    (item) => item.filePath,
    "CaseSpec sourceName for windows",
    problems,
  );
  collectDuplicates(
    swiftTests,
    (item) => item.name,
    swiftLocation,
    "Swift @Test display name",
    problems,
  );
  collectDuplicates(
    csharpTests,
    (item) => item.name,
    csharpLocation,
    `C# ${csharpCaseAttribute} source name`,
    problems,
  );

  const macosSpecsByName = new Map(macosSpecs.map((item) => [item.spec.sourceName, item]));
  const swiftTestsByName = new Map(swiftTests.map((item) => [item.name, item]));
  for (const item of macosSpecs) {
    if (!swiftTestsByName.has(item.spec.sourceName)) {
      problems.push(`${item.filePath}: sourceName ${quote(item.spec.sourceName)} has no matching Swift @Test display name.`);
    }
  }
  for (const item of swiftTests) {
    if (!macosSpecsByName.has(item.name)) {
      problems.push(`${swiftLocation(item)}: Swift @Test display name ${quote(item.name)} has no matching CaseSpec sourceName.`);
    }
  }

  const windowsSpecsByName = new Map(windowsSpecs.map((item) => [item.spec.sourceName, item]));
  const csharpTestsByName = new Map(csharpTests.map((item) => [item.name, item]));
  for (const item of windowsSpecs) {
    if (!csharpTestsByName.has(item.spec.sourceName)) {
      problems.push(`${item.filePath}: sourceName ${quote(item.spec.sourceName)} has no matching C# ${csharpCaseAttribute} attribute.`);
    }
  }
  for (const item of csharpTests) {
    if (!windowsSpecsByName.has(item.name)) {
      problems.push(`${csharpLocation(item)}: C# ${csharpCaseAttribute} source name ${quote(item.name)} has no matching CaseSpec sourceName.`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`CaseSpec/platform source mapping validation failed:\n${problems.map((item) => `- ${item}`).join("\n")}`);
  }

  return Object.freeze({
    specCount: specs.length,
    macosSpecCount: macosSpecs.length,
    windowsSpecCount: windowsSpecs.length,
    swiftTestCount: swiftTests.length,
    csharpTestCount: csharpTests.length,
    // Kept as `mappings` for compatibility with the original Swift-only API.
    mappings: Object.freeze(macosSpecs.map((item) => {
      const test = swiftTestsByName.get(item.spec.sourceName);
      return Object.freeze({
        id: item.spec.id,
        sourceName: item.spec.sourceName,
        platform: "macos",
        specPath: item.filePath,
        swiftPath: test.filePath,
        swiftLine: test.line,
        swiftColumn: test.column,
      });
    })),
    csharpMappings: Object.freeze(windowsSpecs.map((item) => {
      const test = csharpTestsByName.get(item.spec.sourceName);
      return Object.freeze({
        id: item.spec.id,
        sourceName: item.spec.sourceName,
        platform: "windows",
        specPath: item.filePath,
        csharpPath: test.filePath,
        csharpLine: test.line,
        csharpColumn: test.column,
      });
    })),
  });
}

function collectDuplicates(items, keyOf, locationOf, label, problems) {
  const seen = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const first = seen.get(key);
    if (first === undefined) seen.set(key, item);
    else {
      problems.push(`${label} ${quote(key)} is duplicated at ${locationOf(first)} and ${locationOf(item)}.`);
    }
  }
}

function assertSourceFiles(label, files) {
  if (!Array.isArray(files)) throw new TypeError(`${label} files must be an array.`);
  for (const [index, file] of files.entries()) {
    if (typeof file !== "object" || file === null
        || typeof file.filePath !== "string" || typeof file.contents !== "string") {
      throw new TypeError(`${label} file at index ${index} must contain string filePath and contents fields.`);
    }
  }
}

function swiftLocation(item) {
  return `${item.filePath}:${item.line}:${item.column}`;
}

function csharpLocation(item) {
  return `${item.filePath}:${item.line}:${item.column}`;
}

function contextualError(filePath, message, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${filePath}: ${message}: ${detail}`, { cause });
}

function quote(value) {
  return JSON.stringify(value);
}
