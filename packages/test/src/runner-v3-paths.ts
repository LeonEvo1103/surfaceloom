import path from "node:path";

export interface RunPathClaim {
  readonly stagingDirectory: string;
  readonly outputDirectory: string;
}

const activeClaims = new Map<object, RunPathClaim>();

/**
 * Process-local atomic ownership only. Cross-process exclusion deliberately awaits
 * a future lockfile contract; this registry must not be described as covering it.
 */
export function claimRunPaths(stagingInput: string, outputInput: string): RunPathClaim {
  const stagingDirectory = path.resolve(stagingInput);
  const outputDirectory = path.resolve(outputInput);
  if (pathsOverlap(stagingDirectory, outputDirectory)) {
    throw new Error("Runner v3 staging and output directories must be disjoint.");
  }
  const requested = [stagingDirectory, outputDirectory];
  for (const claim of activeClaims.values()) {
    const active = [claim.stagingDirectory, claim.outputDirectory];
    if (requested.some((candidate) => active.some((owned) => pathsOverlap(candidate, owned)))) {
      throw new Error("Runner v3 path conflicts with an active in-process run.");
    }
  }
  const token = Object.freeze({ stagingDirectory, outputDirectory });
  activeClaims.set(token, token);
  return token;
}

export function releaseRunPaths(claim: RunPathClaim): void {
  activeClaims.delete(claim as object);
}

/** Exact equality or a real ancestor/descendant relationship. */
export function pathsOverlap(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  if (relative === "") return true;
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
  return !outside;
}
