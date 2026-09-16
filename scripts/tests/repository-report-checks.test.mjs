import assert from "node:assert/strict";
import test from "node:test";

import {
  check,
  defineRepositoryChecks,
  repositorySpec,
} from "../repository-report-checks.mjs";

test("Windows package checks execute npm's JavaScript entry point through Node", () => {
  const plan = defineRepositoryChecks("win32", {
    nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
    npmExecPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  });
  const packageChecks = plan.checks.slice(0, 3);

  assert.equal(plan.platform, "windows");
  assert.equal(packageChecks.length, 3);
  for (const check of packageChecks) {
    assert.equal(check.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.equal(check.args[0], "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js");
    assert.equal(check.args.at(-1), "test");
  }
  assert.equal(
    plan.checks.find((check) => check.spec.id === "repository-contracts")?.args[0],
    "scripts/run-repository-contract-tests.mjs",
  );
  assert.equal(plan.checks.at(-1)?.spec.id, "windows-dotnet");
});

test("macOS checks include the architecture guard and non-duplicating Swift run", () => {
  const plan = defineRepositoryChecks("darwin", {
    nodeExecPath: "/opt/node/bin/node",
    npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
  });

  assert.equal(plan.platform, "macos");
  assert.deepEqual(plan.checks.slice(-2).map((entry) => entry.spec.id), [
    "architecture",
    "macos-swift",
  ]);
  assert.deepEqual(plan.checks.at(-1)?.args, [
    "scripts/run-swift-tests.sh",
    "--skip-architecture",
  ]);
});

test("bundled repository cases carry canonical Chinese names and original semantics", () => {
  const plan = defineRepositoryChecks("darwin", {
    nodeExecPath: "/opt/node/bin/node",
    npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
  });

  for (const { spec } of plan.checks) {
    assert.equal(spec.locale, "zh-CN");
    assert.match(spec.suite.name, /\p{Script=Han}/u);
    assert.match(spec.name, /\p{Script=Han}/u);
    assert.match(spec.intent, /\p{Script=Han}/u);
    assert.ok(spec.acceptanceCriteria.length > 0);
    assert.ok(spec.platforms.includes("macos"));
    for (const criterion of spec.acceptanceCriteria) {
      assert.match(criterion.text, /\p{Script=Han}/u);
    }
  }
});

test("repository cases declare only platforms on which their commands run", () => {
  const macos = defineRepositoryChecks("darwin", {
    nodeExecPath: "/opt/node/bin/node",
    npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
  });
  const windows = defineRepositoryChecks("win32", {
    nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
    npmExecPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  });

  assert.deepEqual(
    macos.checks.filter((check) => check.spec.id.startsWith("macos-") || check.spec.id === "architecture")
      .map((check) => check.spec.platforms),
    [["macos"], ["macos"]],
  );
  assert.deepEqual(windows.checks.at(-1)?.spec.platforms, ["windows"]);
  assert.ok(windows.checks.slice(0, 4).every((entry) =>
    entry.spec.platforms.includes("windows")),
  );
});

test("product checks are injected after shared checks without reversing dependencies", () => {
  const productCheck = check(repositorySpec({
    id: "sample-product",
    name: "示例产品契约",
    sourceName: "Sample product contracts",
    intent: "验证产品能够从自己的边界注册仓库检查。",
    criteria: [["registered", "产品检查已显式注册。"]],
    platforms: ["macos"],
  }), "/bin/bash", [["pro", "jects", "sample", "scripts", "check.sh"].join("/")]);
  const plan = defineRepositoryChecks("darwin", {
    nodeExecPath: "/opt/node/bin/node",
    npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
  }, { productChecks: [productCheck] });

  assert.equal(plan.checks.at(-1), productCheck);
  assert.throws(
    () => defineRepositoryChecks("darwin", {
      nodeExecPath: "/opt/node/bin/node",
      npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    }, { productChecks: [productCheck, productCheck] }),
    /ids must be unique/,
  );
});

test("repository check plans fail closed for unsupported hosts and relative tools", () => {
  assert.throws(
    () => defineRepositoryChecks("linux", {
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
    }),
    /supported on macOS and Windows/,
  );
  assert.throws(
    () => defineRepositoryChecks("win32", {
      nodeExecPath: "node.exe",
      npmExecPath: "npm-cli.js",
    }),
    /Node executable path must be absolute/,
  );
  assert.throws(
    () => defineRepositoryChecks("win32", {
      nodeExecPath: "C:\\nodejs\\node.exe",
      npmExecPath: "npm-cli.js",
    }),
    /launched through npm/,
  );
  assert.throws(
    () => defineRepositoryChecks("darwin", {
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/usr/bin/npm",
    }, { productChecks: [{}] }),
    /malformed/,
  );
});
