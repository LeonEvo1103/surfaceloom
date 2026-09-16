import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateCaseSpecDirectories } from "../validate-case-specs.mjs";

const sourceName = "Mapped Windows case";
const spec = {
  id: "sample.windows.mapped",
  locale: "zh-CN",
  platforms: ["windows"],
  suite: { id: "sample.windows", name: "桌面窗口" },
  name: "映射一个 Windows 用例",
  sourceName,
  intent: "验证整个编译源码树中的原生用例都进入映射检查。",
  preconditions: [],
  acceptanceCriteria: [{ id: "mapped", text: "原生用例具有唯一映射。" }],
  sideEffect: "readOnly",
};

test("C# directory discovery includes cases outside a Tests directory", async () => {
  const root = await fixture();
  try {
    const hidden = path.join(root, "windows", "Adapter", "HiddenCase.cs");
    await write(hidden, '[SampleCase("Case outside Tests")] void Hidden() {}\n');
    await assert.rejects(
      validate(root),
      /Case outside Tests.*no matching CaseSpec sourceName/u,
    );

    await unlink(hidden);
    const result = await validate(root);
    assert.equal(result.csharpTestCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CaseSpec source discovery rejects symbolic links instead of shrinking its domain", async () => {
  const root = await fixture();
  try {
    const external = path.join(root, "external", "LinkedCase.cs");
    await write(external, '[SampleCase("Unmapped linked case")] void Linked() {}\n');
    const linked = path.join(root, "windows", "LinkedCase.cs");
    await symlink(external, linked);

    await assert.rejects(
      validate(root),
      /Symbolic links are not allowed.*LinkedCase\.cs/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-case-discovery-"));
  await write(
    path.join(root, "cases", "mapped.case-spec.json"),
    `${JSON.stringify(spec)}\n`,
  );
  await write(
    path.join(root, "windows", "Tests", "MappedCase.cs"),
    `[SampleCase("${sourceName}")] void Mapped() {}\n`,
  );
  for (const directory of [".build", "artifacts", "bin", "dist", "node_modules", "obj"]) {
    await write(
      path.join(root, "windows", directory, "GeneratedCase.cs"),
      `[SampleCase("Generated in ${directory}")] void Generated() {}\n`,
    );
  }
  return root;
}

function validate(root) {
  return validateCaseSpecDirectories({
    specDir: path.join(root, "cases"),
    csharpDir: path.join(root, "windows"),
    csharpCaseAttribute: "SampleCase",
  });
}

async function write(target, contents) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}
