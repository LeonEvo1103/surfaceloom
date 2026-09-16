import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BrowserArtifact } from "./contracts.js";
import { BrowserAutomationError } from "./errors.js";

/** Captured screenshot/trace writers are followed by explicit POSIX confinement. */
export async function captureArtifact(
  kind: "screenshot" | "trace",
  contentType: "image/png" | "application/zip",
  outputPath: string,
  capture: (target: string) => Promise<void>,
): Promise<BrowserArtifact> {
  const target = await prepareArtifactPath(outputPath, contentType === "image/png" ? ".png" : ".zip");
  await capture(target);
  if (process.platform !== "win32") {
    try {
      await chmod(target, 0o600);
    } catch (error) {
      throw new BrowserAutomationError(
        "artifactNotSecured",
        "The browser artifact was captured but could not be restricted to owner-only access.",
        error,
      );
    }
  }
  return browserArtifact(kind, target, contentType);
}

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

/**
 * Writes a credential-equivalent artifact the way `packages/reporter` already
 * writes its bundle: an owner-only `.partial` created with `wx`, then `rename`
 * onto the destination. Handing the final path to a library writer instead means
 * an `O_TRUNC` open, so a process killed mid-write leaves the destination
 * irreversibly emptied — for a storage state that only a real login can rebuild.
 * `rename` is atomic within a directory, so a reader sees either the previous
 * export or the new one. The `wx` flag doubles as a same-path write lock, and
 * `mode: 0o600` closes the window a write-then-chmod would leave open.
 */
export async function writeSensitiveArtifactFile(
  target: string,
  contents: string,
): Promise<void> {
  const partial = `${target}.partial`;
  try {
    await writeFile(partial, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    // The residue is not ours: another in-flight export owns it, or a previous
    // run died holding it. Removing it here would erase a concurrent writer's
    // work, which is exactly what the `wx` lock exists to prevent.
    if (isAlreadyExists(error)) {
      throw new BrowserAutomationError(
        "artifactState",
        "Another browser artifact export is already writing this destination.",
        error,
      );
    }
    await removeQuietly(partial);
    throw new BrowserAutomationError(
      "operationFailed",
      "The browser could not stage the artifact file.",
      error,
    );
  }
  try {
    await rename(partial, target);
  } catch (error) {
    // The partial is ours, so clear it; leaving it behind would make the next
    // export fail against our own debris.
    await removeQuietly(partial);
    throw new BrowserAutomationError(
      "operationFailed",
      "The browser could not publish the artifact file.",
      error,
    );
  }
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await rm(target, { force: true });
  } catch {
    // Cleanup is best effort: the caller already has the real failure to report.
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "EEXIST";
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
