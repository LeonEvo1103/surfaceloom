import { redactReportText } from "@surfaceloom/reporter";
import { suiteExitCodes, type SuiteExitCode } from "../report/contracts.js";
import { parseCliArguments, cliUsage } from "./arguments.js";
import type { CliIO, ExecuteCaseSuiteOptions } from "./contracts.js";
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
    if (args.platform === undefined) throw new Error("--platform is required.");
    if (args.output === undefined) throw new Error("--output is required.");
    if (args.sources.length === 0) throw new Error("At least one Case module source is required.");
    const cases = await discoverCases(args.sources);
    const timestamp = new Date().toISOString();
    const options: ExecuteCaseSuiteOptions = {
      platform: args.platform,
      run: {
        id: args.runId ?? defaultRunId(timestamp),
        title: args.title ?? "SurfaceLoom Case 测试运行",
        app: {
          id: args.appId ?? "surfaceloom.case-suite",
          name: args.appName ?? "SurfaceLoom Case Suite",
        },
      },
      ...(args.timeoutMs === undefined ? {} : { defaults: { timeoutMs: args.timeoutMs } }),
      ...((args.ids.length === 0 && args.filters.length === 0) ? {} : {
        selection: {
          ...(args.ids.length === 0 ? {} : { ids: args.ids }),
          ...(args.filters.length === 0 ? {} : { filters: args.filters }),
        },
      }),
    };
    const result = await runCaseSuite(cases, options, args.output);
    const { summary } = result.report;
    io.stdout.write([
      `Report: ${result.report.bundle.reportPath}`,
      `Cases: ${summary.discovered}; passed=${summary.passed}; failed=${summary.failed}; timedOut=${summary.timedOut}; unsupported=${summary.unsupported}; skipped=${summary.skipped}`,
      `Status: ${result.report.status}`,
      "",
    ].join("\n"));
    return result.report.exitCode;
  } catch (error) {
    io.stderr.write(`SurfaceLoom CLI: ${safeCliMessage(error)}\n`);
    return suiteExitCodes.cliError;
  }
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
