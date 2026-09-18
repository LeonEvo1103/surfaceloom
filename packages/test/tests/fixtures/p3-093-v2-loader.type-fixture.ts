import {
  defineProject,
  loadProjectCases,
  resolveProject,
} from "@surfaceloom/test";

const resolved = resolveProject(defineProject({ cases: ["cases"] }), {
  configPath: "surfaceloom.config.mjs",
});

async function legacyLoaderInference(): Promise<readonly string[]> {
  const loaded = await loadProjectCases(resolved);
  return loaded.cases.map((item) => item.definition.spec.id);
}

void legacyLoaderInference;
