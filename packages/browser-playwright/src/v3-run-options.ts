import path from "node:path";

import {
  defineExecutionPlan,
  type EffectDescriptor,
  type ExecutionEffectPolicy,
  type HostOS,
  type RunCaseV3Identity,
  type RunCaseV3Options,
} from "@surfaceloom/test";

import {
  createPlaywrightBrowserSurfaceBackend,
  playwrightBrowserSurfaceCapabilities,
  type PlaywrightBrowserSurfaceBackendOptions,
} from "./v3-port.js";

const defaultRunnerHostId = "surfaceloom.runner";
const defaultBrowserHostId = "playwright.local";
const defaultSurfaceId = "page";

export interface PlaywrightBrowserRunBrowserOptions extends
  Omit<PlaywrightBrowserSurfaceBackendOptions, "hostId"> {
  readonly hostId?: string;
  readonly surfaceId?: string;
  readonly engine?: "chromium" | "firefox" | "webkit";
  readonly headless?: boolean;
  readonly timeoutMs?: number;
}

export interface PlaywrightBrowserRunHostOptions {
  readonly hostId?: string;
  readonly hostOS?: HostOS;
  readonly name?: string;
  readonly browserName?: string;
}

export interface PlaywrightBrowserRunBudgets {
  readonly executionTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly cancellationGraceMs?: number;
}

export interface PlaywrightBrowserRunOptionsInput {
  readonly spec: Parameters<typeof defineExecutionPlan>[0]["spec"];
  readonly run: Omit<RunCaseV3Identity, "hosts">;
  readonly outputDirectory: string;
  readonly stagingDirectory?: string;
  /** Declares what this execution may attempt; it never grants an effect. */
  readonly effects: readonly EffectDescriptor[];
  /** Independent caller authorization. This preset never derives grants from effects or CaseSpec. */
  readonly policy: ExecutionEffectPolicy;
  readonly browser?: PlaywrightBrowserRunBrowserOptions;
  readonly runner?: PlaywrightBrowserRunHostOptions;
  readonly budgets?: PlaywrightBrowserRunBudgets;
  readonly signal?: AbortSignal;
  readonly requiredEvidence?: RunCaseV3Options["requiredEvidence"];
  readonly evidencePolicy?: RunCaseV3Options["evidencePolicy"];
  readonly executionGate?: RunCaseV3Options["executionGate"];
  readonly judge?: RunCaseV3Options["judge"];
}

/**
 * Builds the ordinary runCaseV3 options for one owned Playwright surface.
 * Effects and policy are deliberately separate required inputs: omission is rejected,
 * and the preset never turns a Case declaration into runtime authorization.
 */
export function createPlaywrightBrowserRunOptions(
  input: PlaywrightBrowserRunOptionsInput,
): RunCaseV3Options {
  if (input.effects === undefined) {
    throw new TypeError("Playwright browser run effects must be supplied explicitly.");
  }
  if (input.policy === undefined) {
    throw new TypeError("Playwright browser run policy must be supplied explicitly.");
  }
  if (typeof input.outputDirectory !== "string" || input.outputDirectory.length === 0) {
    throw new TypeError("Playwright browser run outputDirectory must be a non-empty path.");
  }

  const browser = input.browser ?? {};
  const runner = input.runner ?? {};
  const budgets = input.budgets ?? {};
  const runnerHostId = runner.hostId ?? defaultRunnerHostId;
  const browserHostId = browser.hostId ?? defaultBrowserHostId;
  const surfaceId = browser.surfaceId ?? defaultSurfaceId;
  const hostOS = runner.hostOS ?? currentHostOS();
  const capabilities = playwrightBrowserSurfaceCapabilities;
  const environment = Object.freeze({
    platform: "web" as const,
    host: Object.freeze({ os: hostOS }),
    surfaces: Object.freeze({
      [surfaceId]: Object.freeze({ kind: "browser" as const, capabilities }),
    }),
  });
  const backend = createPlaywrightBrowserSurfaceBackend({
    hostId: browserHostId,
    ...(browser.loader === undefined ? {} : { loader: browser.loader }),
    ...(browser.channel === undefined ? {} : { channel: browser.channel }),
    ...(browser.executablePath === undefined ? {} : { executablePath: browser.executablePath }),
    ...(browser.arguments === undefined ? {} : { arguments: browser.arguments }),
  });
  const outputDirectory = path.resolve(input.outputDirectory);

  return Object.freeze({
    platform: "web" as const,
    runnerHostId,
    run: Object.freeze({ ...input.run, hosts: Object.freeze([
      Object.freeze({ id: runnerHostId, os: hostOS, name: runner.name ?? "SurfaceLoom runner" }),
      Object.freeze({ id: browserHostId, os: hostOS,
        name: runner.browserName ?? "Owned Playwright browser" }),
    ]) }),
    surfaces: Object.freeze([{ kind: "browser" as const, backend, requirement: Object.freeze({
      kind: "browser" as const,
      surfaceId,
      expectedHostId: browserHostId,
      capabilities,
      engine: browser.engine ?? "chromium",
      headless: browser.headless ?? true,
      timeoutMs: browser.timeoutMs ?? 10_000,
    }) }]),
    ...(input.requiredEvidence === undefined ? {} : { requiredEvidence: input.requiredEvidence }),
    ...(input.evidencePolicy === undefined ? {} : { evidencePolicy: input.evidencePolicy }),
    ...(input.executionGate === undefined ? {} : { executionGate: input.executionGate }),
    ...(input.judge === undefined ? {} : { judge: input.judge }),
    execution: Object.freeze({
      plan: defineExecutionPlan({ spec: input.spec, requirements: {
        host: { os: [hostOS] }, surfaces: environment.surfaces,
      }, effects: input.effects }),
      environment,
      policy: input.policy,
      timeoutMs: budgets.executionTimeoutMs ?? 20_000,
      cleanupTimeoutMs: budgets.cleanupTimeoutMs ?? 5_000,
      ...(budgets.cancellationGraceMs === undefined ? {} : {
        cancellationGraceMs: budgets.cancellationGraceMs,
      }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
    stagingDirectory: input.stagingDirectory === undefined
      ? defaultStagingDirectory(outputDirectory)
      : path.resolve(input.stagingDirectory),
    outputDirectory,
  });
}

function defaultStagingDirectory(outputDirectory: string): string {
  return path.join(path.dirname(outputDirectory), `${path.basename(outputDirectory)}.staging`);
}

function currentHostOS(): HostOS {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}
