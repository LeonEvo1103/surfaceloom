import { redactReportText, RequiredArtifactPublicationError } from "@surfaceloom/reporter";
import type { TestPlatform } from "@surfaceloom/core";
import { loadProjectCases } from "../loader.js";
import { preflightResolvedProject, resolveProject } from "../project.js";
import { suiteExitCodes, type SuiteExitCode } from "../report/contracts.js";
import { RunCaseV3Error } from "../runner-v3-error.js";
import { parseCliArguments, cliUsage } from "./arguments.js";
import { loadProjectConfig } from "./config-loader.js";
import type { CliIO, ExecuteCaseSuiteOptions, RunnableCase } from "./contracts.js";
import { discoverCases } from "./discovery.js";
import { runCaseSuite } from "./execute-suite.js";

const defaultIO: CliIO = { stdout: process.stdout, stderr: process.stderr };

/** Testable CLI boundary. It returns an exit code and never exits the process. */
export async function runCli(
  argv: readonly string[],
  io: CliIO = defaultIO,
): Promise<SuiteExitCode> {
  try {
    const args = parseCliArguments(argv);
    if (args.help) { io.stdout.write(cliUsage); return suiteExitCodes.passed; }
    let cases: readonly RunnableCase[];
    let platform: TestPlatform;
    let output: string;
    let timeoutMs: number | undefined;
    if (args.config === undefined) {
      if (args.platform === undefined) throw new Error("--platform is required.");
      if (args.output === undefined) throw new Error("--output is required.");
      if (args.sources.length === 0) throw new Error("At least one Case module source is required.");
      cases = await discoverCases(args.sources);
      platform = args.platform;
      output = args.output;
      timeoutMs = args.timeoutMs;
    } else {
      const configured = await configuredRun(args);
      cases = configured.cases;
      platform = configured.platform;
      output = configured.output;
      timeoutMs = configured.timeoutMs;
    }
    const timestamp = new Date().toISOString();
    const options: ExecuteCaseSuiteOptions = {
      platform,
      run: {
        id: args.runId ?? defaultRunId(timestamp),
        title: args.title ?? "SurfaceLoom Case 测试运行",
        app: {
          id: args.appId ?? "surfaceloom.case-suite",
          name: args.appName ?? "SurfaceLoom Case Suite",
        },
      },
      ...(timeoutMs === undefined ? {} : { defaults: { timeoutMs } }),
      ...((args.ids.length === 0 && args.filters.length === 0) ? {} : {
        selection: {
          ...(args.ids.length === 0 ? {} : { ids: args.ids }),
          ...(args.filters.length === 0 ? {} : { filters: args.filters }),
        },
      }),
    };
    const result = await runCaseSuite(cases, options, output);
    const { summary } = result.report;
    io.stdout.write([
      `Report: ${result.report.bundle.reportPath}`,
      `Cases: ${summary.discovered}; passed=${summary.passed}; failed=${summary.failed}; timedOut=${summary.timedOut}; unsupported=${summary.unsupported}; skipped=${summary.skipped}`,
      `Status: ${result.report.status}`,
      "",
    ].join("\n"));
    return result.report.exitCode;
  } catch (error) {
    const publication = error instanceof RequiredArtifactPublicationError
      || error instanceof RunCaseV3Error && error.additionalFailure.phase === "publication";
    io.stderr.write(`SurfaceLoom CLI${publication ? " publication" : ""}: ${safeCliMessage(error)}\n`);
    return cliFailureExitCode(error);
  }
}

/** Publication is an infrastructure/CLI failure; it never rewrites a Case verdict. */
export function cliFailureExitCode(_error: unknown): typeof suiteExitCodes.cliError {
  return suiteExitCodes.cliError;
}

async function configuredRun(args: ReturnType<typeof parseCliArguments>) {
  const loaded = await loadProjectConfig(args.config!);
  const hasOverrides = args.sources.length > 0 || args.platform !== undefined
    || args.output !== undefined || args.timeoutMs !== undefined;
  const resolved = resolveProject(loaded.project, {
    configPath: loaded.configPath,
    ...(hasOverrides ? { overrides: {
      ...(args.sources.length === 0 ? {} : { sources: args.sources }),
      ...(args.platform === undefined ? {} : { platform: args.platform }),
      ...(args.output === undefined ? {} : { outputDir: args.output }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    } } : {}),
  });
  if (resolved.platform === undefined) {
    throw new Error("--platform is required unless supplied by --config.");
  }
  if (resolved.outputDir === undefined) {
    throw new Error("--output is required unless supplied by --config.");
  }
  await preflightResolvedProject(resolved);
  const loadedCases = await loadProjectCases(resolved, {
    ...(loaded.typescriptRuntime === undefined ? {} : { typescriptRuntime: loaded.typescriptRuntime }),
  });
  return Object.freeze({ cases: loadedCases.cases, platform: resolved.platform,
    output: resolved.outputDir, timeoutMs: resolved.timeoutMs });
}

function defaultRunId(timestamp: string): string {
  return `sl-test-${timestamp.replace(/[^0-9]/gu, "")}`;
}

function safeCliMessage(error: unknown): string {
  try {
    const message = typeof error === "object" && error !== null && "message" in error
      ? error.message : error;
    return redactReportText(typeof message === "string" && message.length > 0
      ? message : "Unknown CLI error.");
  } catch {
    return "Unreadable CLI error.";
  }
}
