import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { BrowserArtifact } from "./contracts.js";
import { BrowserAutomationError } from "./errors.js";

export async function prepareArtifactPath(
  outputPath: string,
  extension: string,
): Promise<string> {
  if (!path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== extension) {
    throw new BrowserAutomationError(
      "invalidArgument",
      `Browser artifact paths must be absolute ${extension} files.`,
    );
  }
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  return path.resolve(outputPath);
}

export function browserArtifact(
  kind: BrowserArtifact["kind"],
  sourcePath: string,
  contentType: BrowserArtifact["contentType"],
): BrowserArtifact {
  return Object.freeze({
    kind,
    sourcePath,
    contentType,
    capturedAt: new Date().toISOString(),
    sensitive: true,
  });
}
