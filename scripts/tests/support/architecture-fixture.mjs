import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const guard = path.join(repositoryRoot, "scripts/check-architecture.sh");

export async function withArchitectureFixture(
  files,
  assertion,
  searchBackend = "auto",
) {
  return withPreparedArchitectureFixture(async (root) => {
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }
  }, assertion, searchBackend);
}

export async function withPreparedArchitectureFixture(
  prepare,
  assertion,
  searchBackend = "auto",
) {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-architecture-"));
  try {
    const environmentOverrides = (await prepare(root)) ?? {};
    await assertion(runGuard(root, searchBackend, environmentOverrides));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runGuard(root, searchBackend, environmentOverrides) {
  return spawnSync("bash", [guard], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environmentOverrides,
      SURFACELOOM_ARCHITECTURE_ROOT: root,
      SURFACELOOM_ARCHITECTURE_SEARCH_BACKEND: searchBackend,
    },
  });
}
