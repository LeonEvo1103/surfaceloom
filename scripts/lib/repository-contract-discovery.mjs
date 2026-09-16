import path from "node:path";

import {
  findSourceTreeFiles,
  readSourceTreeDirectories,
} from "./source-tree-files.mjs";

export async function discoverRepositoryContractTests(repositoryRoot) {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new Error("The repository root must be absolute.");
  }

  const discovered = await findSourceTreeFiles(
    path.join(repositoryRoot, "scripts", "tests"),
    (_, name) => name.endsWith(".test.mjs"),
    { allowMissing: true },
  );
  const projectsDirectory = path.join(repositoryRoot, "projects");
  const products = await readSourceTreeDirectories(projectsDirectory, {
    allowMissing: true,
    ignoreHidden: true,
    ignoredDirectoryNames: [],
  });

  for (const productDirectory of products) {
    const productName = path.basename(productDirectory);
    const contracts = await findSourceTreeFiles(
      path.join(productDirectory, "contracts"),
      (_, name) => name.endsWith(".test.mjs"),
      { allowMissing: true },
    );
    if (await declaresNativeCases(productDirectory) && contracts.length === 0) {
      throw new Error(
        `Product '${productName}' has native tests or CaseSpecs but no product contract tests.`,
      );
    }
    discovered.push(...contracts);
  }

  discovered.sort((left, right) => left.localeCompare(right, "en"));
  if (discovered.length === 0) {
    throw new Error("No repository or product contract tests were discovered.");
  }
  return Object.freeze(discovered);
}

async function declaresNativeCases(productDirectory) {
  const matches = await findSourceTreeFiles(productDirectory, (relativePath, name) => {
    if (name.endsWith(".case-spec.json")) return true;
    const segments = relativePath.split(path.sep);
    return segments.includes("Tests") && [".cs", ".swift"].includes(path.extname(name));
  });
  return matches.length > 0;
}
