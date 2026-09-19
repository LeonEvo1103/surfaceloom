import { createPlaywrightBrowserSurfaceBackend } from "@surfaceloom/browser-playwright/v3";
import { defineExecutionPlan } from "@surfaceloom/test";

const capabilities = Object.freeze([
  "browser.navigate", "browser.dom.inspect", "browser.dom.invoke",
]);
const effects = Object.freeze([
  effect("browser.session", "execute", "local", "unknown"),
  effect("browser.navigate", "write", "external", "unknown"),
  effect("browser.click", "write", "local", "unknown"),
  effect("browser.waitVisible", "read", "local", "notNeeded"),
  effect("browser.readText", "read", "local", "notNeeded"),
]);

/** Shared reference-agent Browser v3 wiring. Callers only supply Case/run identities and budgets. */
export function referenceAgentBrowserRunOptions({
  spec,
  run,
  reportRunId,
  runnerHostId,
  browserHostId,
  browserSurfaceId,
  requiredArtifactId,
  requireComplete,
  stagingDirectory,
  outputDirectory,
  browser,
  executionTimeoutMs = 20_000,
  cleanupTimeoutMs = 5_000,
  runnerHostName = "SurfaceLoom runner",
  wrapBackend = (backend) => backend,
}) {
  const host = hostOS();
  const created = createPlaywrightBrowserSurfaceBackend({ hostId: browserHostId,
    executablePath: browser.executablePath });
  const backend = wrapBackend(created);
  const environment = Object.freeze({ platform: "web", host: { os: host }, surfaces: {
    [browserSurfaceId]: { kind: "browser", capabilities },
  } });
  const policy = Object.freeze({ maximumSideEffect: "externalEffect",
    grants: effects.map((item) => ({ resource: item.resource, operations: [item.operation],
      boundaries: [item.boundary], ...(item.recovery === "unknown"
        ? { allowUnknownRecovery: true } : {}) })) });
  return Object.freeze({
    platform: "web", runnerHostId,
    run: { ...run, id: reportRunId, hosts: [
      { id: runnerHostId, os: host, name: runnerHostName },
      { id: browserHostId, os: host, name: "Owned Playwright browser" },
    ] },
    surfaces: [{ kind: "browser", backend, requirement: { kind: "browser",
      surfaceId: browserSurfaceId, expectedHostId: browserHostId, capabilities,
      engine: browser.engine, headless: true, timeoutMs: 10_000 } }],
    requiredEvidence: [{ artifactId: requiredArtifactId, requireComplete }],
    execution: { plan: defineExecutionPlan({ spec,
      requirements: { host: { os: [host] }, surfaces: environment.surfaces }, effects }),
      environment, policy, timeoutMs: executionTimeoutMs, cleanupTimeoutMs },
    stagingDirectory, outputDirectory,
  });
}

function effect(resource, operation, boundary, recovery) {
  return Object.freeze({ resource, operation, boundary, recovery,
    securitySensitive: false });
}

function hostOS() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}
