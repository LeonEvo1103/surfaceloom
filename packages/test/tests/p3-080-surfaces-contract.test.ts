import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopPlatform } from "@surfaceloom/core";

import { defineCase } from "../src/definition.js";
import type { ResourceRegistration } from "../src/resources-contracts.js";
import { createBrowserSurfaceFactory } from "../src/surfaces/browser.js";
import type {
  BrowserSurfaceBackendPort,
  NativeSurfaceBackendPort,
  NativeSurfaceRequirement,
  NativeSurfaceSessionPort,
  SurfaceEvidenceEvent,
  SurfaceSetupContext,
} from "../src/surfaces/contracts.js";
import { SurfaceProviderError } from "../src/surfaces/errors.js";
import { createNativeSurfaceFactory } from "../src/surfaces/native.js";
import { spec } from "./support.js";

test("legacy Case definition and importing factories do not load or launch an optional backend", () => {
  let launches = 0;
  const backend = browserBackend(() => { launches += 1; return browserSession("session-1"); });
  const factory = createBrowserSurfaceFactory(backend);
  const legacy = defineCase({ spec: spec("legacy.surface.case"), run: () => undefined });
  assert.equal(legacy.spec.id, "legacy.surface.case");
  assert.equal(typeof factory.setup, "function");
  assert.equal(launches, 0);
});

test("host and capability mismatches reject before submission with zero replay", async () => {
  let launches = 0;
  const backend = browserBackend(() => { launches += 1; return browserSession("session-1"); });
  const context = setupContext();
  await assert.rejects(createBrowserSurfaceFactory(backend).setup({
    kind: "browser", surfaceId: "page", expectedHostId: "other-host",
    capabilities: ["browser.dom"], engine: "chromium",
  }, context.value), code("hostMismatch"));
  await assert.rejects(createBrowserSurfaceFactory(backend).setup({
    kind: "browser", surfaceId: "page", expectedHostId: "host-1",
    capabilities: ["browser.trace"], engine: "chromium",
  }, context.value), code("capabilityMismatch"));
  assert.equal(launches, 0);
  assert.equal(context.resources.length, 0);
});

test("leased browser fails closed without an outer cleanup stop contract", async () => {
  let launches = 0;
  const backend = browserBackend(() => { launches += 1; return browserSession("session-1"); });
  await assert.rejects(createBrowserSurfaceFactory(backend, { lease: {
    id: "gui-lease", release: async () => ({ status: "released" }),
  } }).setup(browserRequirement("page"), setupContext().value), code("invalidRequest"));
  assert.equal(launches, 0);
});

test("native borrowed facade hides identity and rejects lifecycle or cross-backend actions", async () => {
  const events: string[] = [];
  const port = nativePort("macos", events);
  const context = setupContext();
  const author = await createNativeSurfaceFactory(port).setup({
    kind: "native", surfaceId: "native-app", expectedHostId: "host-1",
    platform: "macos", backend: "ax", acquisition: "attach",
    capabilities: ["ui.inspect"], target: "fixture-app",
  }, context.value);
  assert.equal(author.ownership, "borrowed");
  assert.equal("session" in author, false);
  assert.equal("identity" in author, false);
  assert.equal("quit" in author, false);
  assert.equal("terminate" in author, false);
  await assert.rejects(author.perform({ kind: "quit" } as never), code("wrongOwnership"));
  await assert.rejects(author.perform({ kind: "find", locator: {
    backend: "uia", automationId: "wrong",
  } } as never), code("platformMismatch"));
  await author.perform({ kind: "find", locator: { backend: "ax", identifier: "field" } });
  assert.deepEqual(events, ["prepare", "register", "acquire", "invoke.find"]);
});

test("concurrent setup calls keep their deadline and evidence contexts isolated", async () => {
  const budgets: number[] = [];
  const backend: BrowserSurfaceBackendPort = {
    hostId: "host-1", capabilities: ["browser.dom"],
    launch: async (requirement, call) => {
      budgets.push(call.beforeSubmit().timeoutMs);
      await Promise.resolve();
      return browserSession(`session-${requirement.surfaceId}`);
    },
  };
  const left = setupContext({ remainingMs: 30 });
  const right = setupContext({ remainingMs: 300 });
  const factory = createBrowserSurfaceFactory(backend);
  const [leftAuthor, rightAuthor] = await Promise.all([
    factory.setup(browserRequirement("left"), left.value),
    factory.setup(browserRequirement("right"), right.value),
  ]);
  assert.deepEqual([leftAuthor.surfaceId, rightAuthor.surfaceId], ["left", "right"]);
  assert.ok(budgets[0]! <= 30 && budgets[0]! > 0);
  assert.ok(budgets[1]! <= 300 && budgets[1]! > 30);
  assert.deepEqual(left.evidence.map((item) => item.surfaceId), ["left"]);
  assert.deepEqual(right.evidence.map((item) => item.surfaceId), ["right"]);
});

test("failure evidence sink errors never replace the original native action failure", async () => {
  const primary = new Error("primary native action failure");
  const context = setupContext({ evidence: (event) => {
    if (event.kind === "operation" && event.outcome === "failed") {
      throw new Error("secondary evidence failure");
    }
  } });
  const port: NativeSurfaceBackendPort<"macos"> = {
    hostId: "host-1", platform: "macos", backend: "ax", capabilities: ["ui.inspect"],
    prepare: (requirement, setup) => {
      setup.registerResource({ id: "native.controller", ownership: "borrowed" });
      return { acquire: async (call) => {
        call.beforeSubmit();
        return { ownership: requirement.acquisition === "launch" ? "owned" : "borrowed",
          platform: "macos", backend: "ax", capabilities: ["ui.inspect"],
          invoke: async (_action, _setup, operation) => {
            operation.beforeSubmit();
            throw primary;
          } } as never;
      } };
    },
  };
  const author = await createNativeSurfaceFactory(port).setup({
    kind: "native", surfaceId: "native-app", expectedHostId: "host-1",
    platform: "macos", backend: "ax", acquisition: "attach",
    capabilities: ["ui.inspect"], target: "fixture-app",
  }, context.value);
  await assert.rejects(author.perform({ kind: "find", locator: {
    backend: "ax", identifier: "field",
  } }), (error) => error === primary);
});

test("borrowed ownership is immutable even if a backend mutates its session later", async () => {
  let invokes = 0;
  const mutable = {
    ownership: "borrowed",
    platform: "macos",
    backend: "ax",
    capabilities: ["ui.inspect"],
    invoke: async () => { invokes += 1; return null; },
  } as unknown as NativeSurfaceSessionPort<"macos", "borrowed"> & { ownership: string };
  const port: NativeSurfaceBackendPort<"macos"> = {
    hostId: "host-1", platform: "macos", backend: "ax", capabilities: ["ui.inspect"],
    prepare: (_requirement, setup) => {
      setup.registerResource({ id: "native.borrowed", ownership: "borrowed" });
      return { acquire: async (call) => { call.beforeSubmit(); return mutable as never; } };
    },
  };
  const author = await createNativeSurfaceFactory(port).setup({
    kind: "native", surfaceId: "native-app", expectedHostId: "host-1", platform: "macos",
    backend: "ax", acquisition: "attach", capabilities: ["ui.inspect"], target: "fixture-app",
  }, setupContext().value);
  mutable.ownership = "owned";
  await assert.rejects(author.perform({ kind: "quit" } as never), code("wrongOwnership"));
  assert.equal(author.ownership, "borrowed");
  assert.equal(invokes, 0);
});

test("native unknown outcome evidence stays indeterminate without replacing the client error", async () => {
  const primary = Object.assign(new Error("native outcome unknown"), { operationOutcome: "unknown" });
  const context = setupContext();
  const port: NativeSurfaceBackendPort<"macos"> = {
    hostId: "host-1", platform: "macos", backend: "ax", capabilities: ["ui.inspect"],
    prepare: (requirement, setup) => {
      setup.registerResource({ id: "native.unknown", ownership: "borrowed" });
      return { acquire: async (call) => {
        call.beforeSubmit();
        return { ownership: requirement.acquisition === "launch" ? "owned" : "borrowed",
          platform: "macos", backend: "ax", capabilities: ["ui.inspect"],
          invoke: async (_action, _setup, operation) => {
            operation.beforeSubmit(); throw primary;
          } } as never;
      } };
    },
  };
  const author = await createNativeSurfaceFactory(port).setup({
    kind: "native", surfaceId: "native-app", expectedHostId: "host-1", platform: "macos",
    backend: "ax", acquisition: "attach", capabilities: ["ui.inspect"], target: "fixture-app",
  }, context.value);
  await assert.rejects(author.perform({ kind: "find", locator: {
    backend: "ax", identifier: "field",
  } }), (error) => error === primary);
  assert.equal(context.evidence.at(-1)?.outcome, "unknown");
});

function browserRequirement(surfaceId: string) {
  return { kind: "browser" as const, surfaceId, expectedHostId: "host-1",
    capabilities: ["browser.dom"], engine: "chromium" as const, timeoutMs: 1_000 };
}

function browserBackend(
  session: () => ReturnType<typeof browserSession>,
): BrowserSurfaceBackendPort {
  return { hostId: "host-1", capabilities: ["browser.dom"],
    launch: async (_requirement, call) => { call.beforeSubmit(); return session(); } };
}

function browserSession(sessionId: string) {
  return { identity: { hostId: "host-1", sessionId },
    invoke: async (_action: unknown, call: { beforeSubmit(): unknown }) => {
      call.beforeSubmit(); return null;
    },
    close: async () => ({ kind: "browserSessionClosed" as const, hostId: "host-1", sessionId }) };
}

function nativePort<P extends DesktopPlatform>(platform: P, events: string[]): NativeSurfaceBackendPort<P> {
  const backend = (platform === "macos" ? "ax" : "uia") as P extends "macos" ? "ax" : "uia";
  return { hostId: "host-1", platform, backend, capabilities: ["ui.inspect"],
    prepare: <O extends "owned" | "borrowed">(
      requirement: NativeSurfaceRequirement<P, O>, context: SurfaceSetupContext,
    ) => {
      events.push("prepare");
      events.push("register");
      context.registerResource({ id: "native.controller", ownership: "borrowed" });
      return { acquire: async (call: { beforeSubmit(): unknown }) => {
        events.push("acquire"); call.beforeSubmit();
        return { ownership: (requirement.acquisition === "launch" ? "owned" : "borrowed") as O,
          platform, backend, capabilities: ["ui.inspect"],
          invoke: async (action: { kind: string }, _context: SurfaceSetupContext,
            operation: { beforeSubmit(): unknown }) => {
            events.push(`invoke.${action.kind}`); operation.beforeSubmit(); return null;
          } };
      } };
    } };
}

function setupContext(options: { remainingMs?: number; signal?: AbortSignal;
  evidence?: (event: SurfaceEvidenceEvent) => void } = {}) {
  const resources: ResourceRegistration[] = [];
  const evidence: SurfaceEvidenceEvent[] = [];
  const remainingMs = options.remainingMs ?? 1_000;
  const value: SurfaceSetupContext = {
    signal: options.signal ?? new AbortController().signal,
    deadlineAt: performance.now() + remainingMs,
    remainingMs: () => remainingMs,
    dispatch: async (effect, action) => action(effect),
    registerResource: (resource) => { resources.push(resource); },
    evidence: { submit: (event) => { evidence.push(event); options.evidence?.(event); } },
  };
  return { value, resources, evidence };
}

function code(expected: SurfaceProviderError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof SurfaceProviderError && error.code === expected;
}
