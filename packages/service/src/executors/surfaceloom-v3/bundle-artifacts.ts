import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { Artifact } from "../../execution.js";
import type { RunId } from "../../ids.js";
import type { ArtifactStore } from "../../stores/contracts.js";
import { StoreConflictError } from "../../stores/contracts.js";

export interface BundleArtifactLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxArtifactBytes: number;
}

interface BundleFile { readonly absolute: string; readonly relative: string; readonly size: number }

export async function publishV3BundleArtifacts(store: ArtifactStore, runId: RunId,
  root: string, limits: BundleArtifactLimits): Promise<readonly Artifact[]> {
  const files = await discover(root, root, [], limits);
  const required = new Set(["report.json", "index.html", "ai-review.md", "complete.json"]);
  for (const name of required) {
    if (!files.some((file) => file.relative === name)) {
      throw new StoreConflictError(`Reporter v3 bundle is missing ${name}.`);
    }
  }
  const artifacts: Artifact[] = [];
  for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) {
    const data = await readFile(file.absolute);
    if (data.byteLength !== file.size) throw new StoreConflictError("Reporter bundle changed while reading.");
    artifacts.push(await store.put({ runId, name: file.relative,
      mediaType: mediaType(file.relative), data }));
  }
  return Object.freeze(artifacts);
}

async function discover(root: string, directory: string, output: BundleFile[],
  limits: BundleArtifactLimits): Promise<BundleFile[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new StoreConflictError("Reporter bundle contains an unsupported filesystem entry.");
    }
    if (entry.isDirectory()) { await discover(root, absolute, output, limits); continue; }
    const descriptor = await stat(absolute);
    if (!descriptor.isFile() || descriptor.size > limits.maxArtifactBytes) {
      throw new StoreConflictError("Reporter artifact exceeds its configured byte limit.");
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    output.push({ absolute, relative, size: descriptor.size });
    if (output.length > limits.maxFiles
        || output.reduce((sum, file) => sum + file.size, 0) > limits.maxTotalBytes) {
      throw new StoreConflictError("Reporter bundle exceeds its configured limits.");
    }
  }
  return output;
}

function mediaType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  return extension === ".json" ? "application/json"
    : extension === ".html" ? "text/html"
      : extension === ".md" ? "text/markdown"
        : extension === ".png" ? "image/png"
          : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
            : extension === ".webp" ? "image/webp" : "application/octet-stream";
}
