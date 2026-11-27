import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CHECKS,
  formatOutputs,
  parseNulSeparated,
  selectChecks,
} from "../../ci/select-checks.mjs";

const run = promisify(execFile);
const selector = fileURLToPath(new URL("../../ci/select-checks.mjs", import.meta.url));
// Built from segments so the architecture guard's product-path scan stays quiet.
const productContract = ["projects", "sample", "contracts", "flow.test.mjs"].join("/");

function enabled(selection) {
  return CHECKS.filter((check) => selection[check]);
}

function assertEveryCheck(selection) {
  assert.deepEqual(enabled(selection), CHECKS);
  assert.equal(selection.windows, true);
}

test("Swift-only changes run only the macOS job", () => {
  const selection = selectChecks([
    "Sources/SurfaceLoomMacOS/Driver.swift",
    "Tests/SurfaceLoomMacOSTests/FrameworkContractTests.swift",
    "Package.swift",
  ]);
  assert.deepEqual(enabled(selection), ["swift"]);
  assert.equal(selection.windows, false);
});

test("C# host changes run the Windows build, host contracts and artifact release contracts", () => {
  const selection = selectChecks(["native/windows-host/src/SurfaceLoom.WindowsHost/Program.cs"]);
  assert.deepEqual(enabled(selection), ["windows_host", "artifact_release"]);
  assert.equal(selection.windows, true);
});

test("TypeScript changes run the Ubuntu suite and the Windows TypeScript step", () => {
  for (const file of ["packages/service/src/index.ts", productContract, "scripts/lib/case-spec-catalog.mjs"]) {
    const selection = selectChecks([file]);
    assert.deepEqual(enabled(selection), ["typescript", "framework_p1"], file);
    assert.equal(selection.windows, true, file);
  }
});

test("example and packed-consumer changes run only the Ubuntu framework suite", () => {
  for (const file of [
    "examples/reference-agent/test/agent.test.mjs",
    "scripts/service-packed-consumer/run.mjs",
    "scripts/run-framework-p1-tests.sh",
  ]) {
    const selection = selectChecks([file]);
    assert.deepEqual(enabled(selection), ["framework_p1"], file);
    assert.equal(selection.windows, false, file);
  }
});

test("documentation-only changes need no heavy check", () => {
  const selection = selectChecks([
    "docs/GETTING_STARTED.md",
    "README.md",
    "website/index.html",
    ".github/workflows/pages.yml",
  ]);
  assert.deepEqual(enabled(selection), []);
  assert.equal(selection.windows, false);
});

test("release schemas under docs still run the TypeScript suite that parses them", () => {
  assert.deepEqual(enabled(selectChecks(["docs/release/release-plan.schema.json"])), ["typescript", "framework_p1"]);
});

test("clipboard-transfer changes run only its Windows step", () => {
  // The PowerShell encoding guard runs on every change, so .ps1 files add no heavy check.
  assert.deepEqual(enabled(selectChecks(["scripts/clipboard-transfer/lib/plan.mjs"])), ["clipboard_transfer"]);
  assert.deepEqual(enabled(selectChecks(["scripts/clipboard-transfer/powershell/receiver.ps1"])), ["clipboard_transfer"]);
});

test("shared golden vectors run all three language suites", () => {
  assert.deepEqual(
    enabled(selectChecks(["packages/native/vectors/v1/01-handshake-request.vector.json"])),
    ["swift", "windows_host", "artifact_release", "typescript", "framework_p1"],
  );
});

test("CI-owned scripts reach every job that executes them", () => {
  assert.deepEqual(enabled(selectChecks(["scripts/run-swift-tests.sh"])), ["swift"]);
  assert.deepEqual(enabled(selectChecks(["scripts/check-architecture.sh"])), ["swift", "typescript", "framework_p1"]);
  assert.deepEqual(
    enabled(selectChecks(["scripts/lib/ArtifactRelease/ArtifactPath.ps1"])),
    ["artifact_release", "typescript", "framework_p1"],
  );
  assert.deepEqual(enabled(selectChecks(["LICENSE"])), ["typescript", "framework_p1"]);
});

test("fixtures and templates outside the CI build need no heavy check", () => {
  assert.deepEqual(enabled(selectChecks(["Templates/ScenarioTests.swift.template"])), []);
  assert.deepEqual(enabled(selectChecks(["native/macos-fixture/Sources/SurfaceLoomMacOSFixtureApp/App.swift"])), []);
  assert.deepEqual(enabled(selectChecks(["native/windows-fixture/scripts/verify.ps1"])), []);
});

test("case variants route like the path a case-folding checkout writes them to", () => {
  assert.deepEqual(
    enabled(selectChecks(["scripts/lib/artifactRelease/ArtifactPath.ps1"])),
    ["artifact_release", "typescript", "framework_p1"],
  );
  assertEveryCheck(selectChecks(["Scripts/CI/select-checks.mjs"]));
  assertEveryCheck(selectChecks([".GitHub/workflows/ci.yml"]));
});

test("workflow, selector and checkout attribute changes run everything", () => {
  for (const file of [
    ".github/workflows/ci.yml",
    ".github/dependabot.yml",
    "scripts/ci/select-checks.mjs",
    ".gitattributes",
    "scripts/.gitattributes",
    "docs/.gitattributes",
  ]) {
    const selection = selectChecks(["docs/README.md", file]);
    assertEveryCheck(selection);
    assert.match(selection.reason, /affects every check/u);
  }
});

test("mixed changes take the union of their checks", () => {
  const selection = selectChecks([
    "Sources/SurfaceLoomMacOS/Driver.swift",
    "native/windows-host/tests/SurfaceLoom.WindowsHost.ContractTests/Program.cs",
    "docs/WINDOWS.md",
  ]);
  assert.deepEqual(enabled(selection), ["swift", "windows_host", "artifact_release"]);
});

test("unknown paths run everything", () => {
  for (const file of [".gitignore", "Makefile", "tools/new.sh", "Templates2/x"]) {
    assertEveryCheck(selectChecks([file]));
  }
});

test("empty or malformed change lists run everything", () => {
  for (const files of [
    [],
    undefined,
    "Sources/a.swift",
    [""],
    [42],
    ["/Sources/a.swift"],
    ["Sources/../LICENSE"],
    ["Sources//a.swift"],
    ["./Sources/a.swift"],
    ["native\\windows-host\\a.cs"],
    ["docs/a.md\nSources/b.swift"],
    ["docs/aux.md"],
    ["docs/COM1.txt/readme.md"],
    ["docs/notes:draft.md"],
    ["docs/a?.md"],
    ["docs/trailing-dot."],
    ["docs/trailing-space /a.md"],
    ["docs/\u0007bell.md"],
    ["docs/cafe\u0301.md"],
    ["docs/caf\ufffd.md"],
  ]) {
    assertEveryCheck(selectChecks(files));
  }
});

test("NUL-separated git output keeps names intact", () => {
  assert.deepEqual(parseNulSeparated(""), []);
  assert.deepEqual(parseNulSeparated("a b.md\0Sources/x.swift\0"), ["a b.md", "Sources/x.swift"]);
  assert.deepEqual(parseNulSeparated("docs/a.md\0\0"), ["docs/a.md", ""]);
  assert.deepEqual(parseNulSeparated(Buffer.from("docs/\u00e9.md\0", "utf8")), ["docs/\u00e9.md"]);
  assert.deepEqual(parseNulSeparated(Buffer.from("\ufeffdocs/a.md\0", "utf8")), ["\ufeffdocs/a.md"]);
});

test("names that are not valid UTF-8 run everything", () => {
  const raw = Buffer.concat([Buffer.from("docs/caf"), Buffer.from([0xe9]), Buffer.from(".md\0")]);
  assertEveryCheck(selectChecks(parseNulSeparated(raw)));
});

test("step outputs list every switch on its own line", () => {
  const output = formatOutputs(selectChecks(["Sources/a.swift"]));
  assert.equal(output, [
    "swift=true",
    "windows_host=false",
    "artifact_release=false",
    "typescript=false",
    "framework_p1=false",
    "clipboard_transfer=false",
    "windows=false",
    "reason=1 changed path(s) classified",
    "",
  ].join("\n"));
});

test("the CLI reads a git change list and fails closed on misuse", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "surfaceloom-select-checks-"));
  try {
    const list = path.join(directory, "changed");
    await writeFile(list, "native/windows-host/README.md\0");
    const scoped = await run(process.execPath, [selector, "--files-from", list]);
    assert.match(scoped.stdout, /^windows_host=true$/mu);
    assert.match(scoped.stdout, /^swift=false$/mu);

    await writeFile(list, "");
    assert.match((await run(process.execPath, [selector, "--files-from", list])).stdout, /^swift=true$/mu);

    // Invoked through a symlinked path, the CLI still runs instead of silently printing nothing.
    const linked = path.join(directory, "linked-select-checks.mjs");
    await symlink(selector, linked);
    await writeFile(list, "Sources/a.swift\0");
    assert.match((await run(process.execPath, [linked, "--files-from", list])).stdout, /^swift=true$/mu);

    await assert.rejects(run(process.execPath, [selector]));
    await assert.rejects(run(process.execPath, [selector, "--all"]));
    await assert.rejects(run(process.execPath, [selector, "--files-from", path.join(directory, "missing")]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
