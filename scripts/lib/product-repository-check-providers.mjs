import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Loads optional product-owned repository checks without naming a product in shared code. */
export async function loadProductRepositoryCheckExtensions(projectsDirectory, tools) {
  if (!path.isAbsolute(projectsDirectory)) {
    throw new Error("The product directory must be absolute.");
  }
  const entries = await readdir(projectsDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const extensions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const modulePath = path.join(projectsDirectory, entry.name, "repository-checks.mjs");
    let metadata;
    try {
      metadata = await lstat(modulePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("A product repository-check provider must be an ordinary file.");
    }
    const provider = await import(pathToFileURL(modulePath).href);
    if (typeof provider.defineProductRepositoryChecks !== "function") {
      throw new Error("A product repository-check provider is missing its entry point.");
    }
    const extension = await provider.defineProductRepositoryChecks(
      tools.hostPlatform,
      tools,
    );
    validateExtension(extension);
    extensions.push(Object.freeze({
      checks: Object.freeze([...extension.checks]),
      suppressedEnvironmentPrefixes: Object.freeze([
        ...extension.suppressedEnvironmentPrefixes,
      ]),
    }));
  }
  return Object.freeze(extensions);
}

function validateExtension(extension) {
  if (!Array.isArray(extension?.checks)
      || !Array.isArray(extension?.suppressedEnvironmentPrefixes)
      || extension.suppressedEnvironmentPrefixes.some((prefix) =>
        typeof prefix !== "string" || !/^[A-Z][A-Z0-9_]*_$/u.test(prefix))) {
    throw new Error("A product repository-check provider returned an invalid extension.");
  }
}
