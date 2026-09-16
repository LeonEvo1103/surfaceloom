#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  redactReportText,
  writeReportBundle,
} from "../packages/reporter/dist/index.js";
import { defineRepositoryChecks } from "./repository-report-checks.mjs";
import {
  loadProductRepositoryCheckExtensions,
} from "./lib/product-repository-check-providers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productExtensions = await loadProductRepositoryCheckExtensions(
  path.join(repositoryRoot, "projects"),
  {
    hostPlatform: process.platform,
    nodeExecPath: process.execPath,
    npmExecPath: process.env.npm_execpath,
  },
);
const plan = defineRepositoryChecks(process.platform, {
  nodeExecPath: process.execPath,
  npmExecPath: process.env.npm_execpath,
}, {
  productChecks: productExtensions.flatMap((extension) => extension.checks),
});
const suppressedEnvironmentPrefixes = [
  "DESKTOP_TEST_",
  ...productExtensions.flatMap((extension) => extension.suppressedEnvironmentPrefixes),
];
const runStartedMs = Date.now();
const runId = `repository-${new Date(runStartedMs).toISOString().replace(/[^0-9]/gu, "")}`;
const defaultOutput = path.join(repositoryRoot, "artifacts", runId);
const outputDirectory = path.resolve(repositoryRoot, process.argv[2] ?? defaultOutput);
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-run-"));

try {
  const results = [];
  for (const definition of plan.checks) {
    results.push(await runCheck(definition));
  }
  const finishedAt = new Date().toISOString();
  const bundle = await writeReportBundle({
    run: {
      id: runId,
      title: "SurfaceLoom 仓库级自动化测试",
      platform: plan.platform,
      startedAt: new Date(runStartedMs).toISOString(),
      finishedAt,
      app: { id: "surfaceloom", name: "SurfaceLoom" },
      environment: {
        osName: os.type(),
        osVersion: os.release(),
        runnerName: "repository-report",
        runnerVersion: "1",
        ci: process.env.CI === "true",
      },
    },
    tests: results,
  }, outputDirectory);
  process.stdout.write(`\nReport: ${bundle.htmlPath}\nStatus: ${bundle.report.status}\n`);
  process.exitCode = bundle.report.status === "passed" ? 0 : 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function runCheck(definition) {
  const startedMs = Date.now();
  process.stdout.write(`\n▶ ${definition.spec.name}\n`);
  const outcome = await execute(
    definition.command,
    definition.args,
    definition.environment,
  );
  const durationMs = Date.now() - startedMs;
  const status = outcome.code === 0 ? "passed" : "failed";
  const logPath = path.join(temporaryDirectory, `${definition.spec.id}.log`);
  const commandLine = [definition.command, ...definition.args].join(" ");
  const output = `${commandLine}\nexitCode=${outcome.code}\n\n${outcome.output}`;
  await writeFile(logPath, redactReportText(output), { encoding: "utf8", mode: 0o600 });
  return {
    spec: definition.spec,
    result: {
      status,
      startedAt: new Date(startedMs).toISOString(),
      durationMs,
      steps: [{
        id: "execute",
        title: "执行对应仓库契约命令",
        status,
        durationMs,
        action: commandLine,
        assertion: "进程退出码等于 0",
        criterionIds: definition.spec.acceptanceCriteria.map((item) => item.id),
      }],
      ...(status === "failed" ? {
        error: {
          category: "command",
          message: `命令退出码为 ${outcome.code}，请查看保留的命令日志。`,
        },
      } : {}),
      artifacts: [{
        id: "command-log",
        kind: "log",
        phase: status === "passed" ? "after" : "failure",
        title: `${definition.spec.name}日志`,
        captureStatus: "captured",
        sourcePath: logPath,
        contentType: "text/plain",
        capturedAt: new Date().toISOString(),
        reviewPriority: status === "passed" ? "secondary" : "primary",
        stepId: "execute",
      }],
    },
  };
}

async function execute(command, args, environment) {
  const chunks = [];
  const maximumBytes = 4 * 1024 * 1024;
  let capturedBytes = 0;
  let truncated = false;
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: safeChildEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    const buffer = Buffer.from(chunk);
    const remaining = maximumBytes - capturedBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const retained = buffer.subarray(0, remaining);
    chunks.push(retained);
    capturedBytes += retained.length;
    if (retained.length !== buffer.length) truncated = true;
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let spawnError;
  const code = await new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      chunks.push(Buffer.from(`\nRunner error: ${String(error)}\n`));
    });
    child.once("close", (exitCode, signal) => {
      if (spawnError !== undefined) {
        resolve(127);
        return;
      }
      if (signal !== null) chunks.push(Buffer.from(`\nStopped by signal ${signal}.\n`));
      resolve(exitCode ?? 1);
    });
  });
  const suffix = truncated ? "\n[Output truncated after 4 MiB.]\n" : "";
  const output = redactReportText(`${Buffer.concat(chunks).toString("utf8")}${suffix}`);
  process.stdout.write(output);
  return { code, output };
}

function safeChildEnvironment(overrides = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const upper = key.toUpperCase();
    return !suppressedEnvironmentPrefixes.some((prefix) => upper.startsWith(prefix));
  }));
  return { ...inherited, ...overrides };
}
