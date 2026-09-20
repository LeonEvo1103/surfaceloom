import assert from "node:assert/strict";
import test from "node:test";

import { ResourceScope } from "../src/resources.js";
import type { ResourceRegistration } from "../src/resources-contracts.js";
import { createBrowserSurfaceFactory } from "../src/surfaces/browser.js";
import { BrowserAcquisitionController } from "../src/surfaces/browser-controller.js";
import { SurfaceCallContext } from "../src/surfaces/call-context.js";
import type {
  BrowserCloseProof,
  BrowserSurfaceBackendPort,
  BrowserSurfaceSessionPort,
  SurfaceEvidenceEvent,
  SurfaceSetupContext,
} from "../src/surfaces/contracts.js";
import { SurfaceProviderError } from "../src/surfaces/errors.js";

test("pre-abort and pre-submit timeout never replay a browser launch", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let launches = 0;
  const immediate = backend(async (_requirement, call) => {
    launches += 1; call.beforeSubmit(); return session();
  });
  const preAborted = setupContext({ signal: aborted.signal });
  await assert.rejects(createBrowserSurfaceFactory(immediate).setup(requirement(), preAborted.value),
    code("aborted"));
  assert.equal(launches, 0);
  assert.equal(preAborted.resources.length, 0);

  const delayed = backend(async (_requirement, call) => {
    launches += 1;
    await delay(20);
    call.beforeSubmit();
    return session();
  });
  const timed = setupContext();
  await assert.rejects(createBrowserSurfaceFactory(delayed).setup({ ...requirement(), timeoutMs: 5 },
    timed.value), code("deadline"));
  await delay(25);
  assert.equal(launches, 1);
  const cleanup = await ownedCleanup(timed.resources[0]!);
  assert.equal(cleanup.status, "released");
});

test("post-submit timeout is unknown, is never retried, and a late session is cleaned", async () => {
  let launches = 0;
  let closes = 0;
  const late = deferred<BrowserSurfaceSessionPort>();
  const injected = backend(async (_requirement, call) => {
    launches += 1;
    call.beforeSubmit();
    return late.promise;
  });
  const context = setupContext();
  await assert.rejects(createBrowserSurfaceFactory(injected).setup({ ...requirement(), timeoutMs: 5 },
    context.value), code("unknownOutcome"));
  late.resolve(session({ close: async () => { closes += 1; return proof(); } }));
  assert.equal((await ownedCleanup(context.resources[0]!)).status, "released");
  assert.equal(launches, 1);
  assert.equal(closes, 1);
});

test("non-finite or exhausted remaining budgets reject before browser submission", async () => {
  for (const remaining of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    let launches = 0;
    const context = setupContext({ remainingMs: () => remaining, deadlineAt: performance.now() + 100 });
    await assert.rejects(createBrowserSurfaceFactory(backend(async (_requirement, call) => {
      launches += 1; call.beforeSubmit(); return session();
    })).setup(requirement(), context.value),
    !Number.isFinite(remaining) ? code("invalidRequest") : code("deadline"));
    assert.equal(launches, 0);
  }
});

test("same-turn resolution after the monotonic deadline is still unknown", async () => {
  let now = 0;
  const context = setupContext({ remainingMs: () => 100, deadlineAt: 10 }).value;
  const call = new SurfaceCallContext(context, undefined, () => now);
  call.beforeSubmit();
  const pending = Promise.resolve().then(() => { now = 11; return "late success"; });
  await assert.rejects(call.wait(pending), code("unknownOutcome"));
});

test("synchronous backend overrun aborts its call and observes a detached rejection", async () => {
  let actions = 0;
  let operationSignal: AbortSignal | undefined;
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  try {
    const context = setupContext();
    const author = await createBrowserSurfaceFactory(backend(async (_requirement, call) => {
      call.beforeSubmit();
      return session({ invoke: (_action, operation) => {
        operationSignal = operation.signal;
        const started = performance.now();
        while (performance.now() - started < 30) { /* deterministic synchronous overrun */ }
        assert.equal(operation.signal.aborted, false);
        return Promise.reject(new Error("late backend rejection"));
      } });
    })).setup(requirement(), context.value);
    await assert.rejects(author.perform({ kind: "navigate", url: "https://example.test" },
      { timeoutMs: 10 }), code("deadline"));
    await delay(5);
    assert.equal(operationSignal?.aborted, true);
    assert.equal(actions, 0);
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener("unhandledRejection", listener); }
});

test("setup evidence failure retains the acquired controller for cleanup", async () => {
  let closes = 0;
  const scope = new ResourceScope({ cleanupTimeoutMs: 50 });
  const context = setupContext({ scope, evidence: (event) => {
    if (event.kind === "acquired") throw new Error("evidence sink failed");
  } });
  const injected = backend(async (_requirement, call) => {
    call.beforeSubmit();
    return session({ close: async () => { closes += 1; return proof(); } });
  });
  await assert.rejects(createBrowserSurfaceFactory(injected).setup(requirement(), context.value),
    /evidence sink failed/);
  assert.equal((await scope.close()).status, "passed");
  assert.equal(closes, 1);
});

test("close failure is sticky and repeated cleanup never calls close twice", async () => {
  let closes = 0;
  const context = setupContext();
  const injected = backend(async (_requirement, call) => {
    call.beforeSubmit();
    return session({ close: async () => { closes += 1; throw new Error("close failed"); } });
  });
  await createBrowserSurfaceFactory(injected).setup(requirement(), context.value);
  const registration = context.resources[0]!;
  const first = await ownedCleanup(registration);
  const second = await ownedCleanup(registration);
  assert.equal(first.status, "unconfirmed");
  assert.deepEqual(second, first);
  assert.equal(closes, 1);
});

test("failure evidence sink errors never replace the original browser action failure", async () => {
  const primary = new Error("primary browser action failure");
  const context = setupContext({ evidence: (event) => {
    if (event.kind === "operation" && event.outcome === "failed") {
      throw new Error("secondary evidence failure");
    }
  } });
  const injected = backend(async (_requirement, call) => {
    call.beforeSubmit();
    return session({ invoke: async (_action, operation) => {
      operation.beforeSubmit();
      throw primary;
    } });
  });
  const author = await createBrowserSurfaceFactory(injected).setup(requirement(), context.value);
  await assert.rejects(author.perform({ kind: "navigate", url: "https://example.test" }),
    (error) => error === primary);
});

for (const fault of ["wrongProof", "timeout"] as const) {
  test(`${fault} keeps the GUI lease and fails cleanup`, async () => {
    let leaseReleases = 0;
    let closeCalls = 0;
    const controllerTimeoutMs = fault === "timeout" ? 10 : 250;
    const scope = new ResourceScope({ cleanupTimeoutMs: fault === "timeout" ? 100 : 500 });
    const context = setupContext({ scope });
    const injected = backend(async (_requirement, call) => {
      call.beforeSubmit();
      return session({ close: async () => {
        closeCalls += 1;
        if (fault === "timeout") return new Promise<BrowserCloseProof>(() => undefined);
        return { ...proof(), sessionId: "wrong-session" };
      } });
    });
    await createBrowserSurfaceFactory(injected, { cleanupTimeoutMs: controllerTimeoutMs,
      cleanupStop: cleanupStop(),
      lease: { id: `lease-${fault}`,
        release: async () => { leaseReleases += 1; return { status: "released" }; } } })
      .setup(requirement(), context.value);
    const result = await scope.close();
    assert.equal(result.status, "failed");
    assert.equal(result.tainted, true);
    assert.equal(closeCalls, 1);
    assert.equal(leaseReleases, 0);
    assert.match(result.failures.map((item) => item.message).join("\n"),
      fault === "timeout" ? /expired|unconfirmed|timed out/ : /proof did not match/);
  });
}

test("late browser close resolution stays tainted and never releases its lease", async () => {
  let leaseReleases = 0;
  const close = deferred<BrowserCloseProof>();
  const scope = new ResourceScope({ cleanupTimeoutMs: 50 });
  const context = setupContext({ scope });
  const injected = backend(async (_requirement, call) => {
    call.beforeSubmit();
    return session({ close: () => close.promise });
  });
  await createBrowserSurfaceFactory(injected, { cleanupTimeoutMs: 5, cleanupStop: cleanupStop(), lease: {
    id: "lease-late", release: async () => { leaseReleases += 1; return { status: "released" }; },
  } }).setup(requirement(), context.value);
  const result = await scope.close();
  assert.equal(result.tainted, true);
  assert.equal(leaseReleases, 0);
  close.resolve(proof());
  await delay(10);
  assert.equal(leaseReleases, 0);
  assert.deepEqual(await scope.close(), result);
});

test("outer cleanup stop after close proof still blocks lease release", async () => {
  let leaseReleases = 0;
  const stop = new AbortController();
  const context = setupContext();
  const injected = backend(async (_requirement, call) => {
    call.beforeSubmit(); return session();
  });
  await createBrowserSurfaceFactory(injected, { cleanupTimeoutMs: 100,
    cleanupStop: { signal: stop.signal, deadlineAt: performance.now() + 1_000 }, lease: {
      id: "lease-outer-stop",
      release: async () => { leaseReleases += 1; return { status: "released" }; },
    } }).setup(requirement(), context.value);
  const sessionReceipt = await ownedCleanup(context.resources[1]!);
  assert.equal(sessionReceipt.status, "released");
  stop.abort(new Error("outer ResourceScope timed out"));
  const leaseReceipt = await ownedCleanup(context.resources[0]!);
  assert.equal(leaseReceipt.status, "unconfirmed");
  assert.equal(leaseReleases, 0);
});

test("outer cleanup timeout during close is sticky after a late proof and holds the lease", async () => {
  let leaseReleases = 0;
  let closes = 0;
  const close = deferred<BrowserCloseProof>();
  const stop = new AbortController();
  const context = setupContext();
  await createBrowserSurfaceFactory(backend(async (_requirement, call) => {
    call.beforeSubmit();
    return session({ close: () => { closes += 1; return close.promise; } });
  }), { cleanupTimeoutMs: 1_000,
    cleanupStop: { signal: stop.signal, deadlineAt: performance.now() + 2_000 }, lease: {
      id: "lease-outer-pending",
      release: async () => { leaseReleases += 1; return { status: "released" }; },
    } }).setup(requirement(), context.value);
  const pending = ownedCleanup(context.resources[1]!);
  await Promise.resolve();
  stop.abort(new Error("outer scope timed out"));
  const first = await pending;
  assert.equal(first.status, "unconfirmed");
  close.resolve(proof());
  await delay(1);
  const lease = await ownedCleanup(context.resources[0]!);
  assert.equal(lease.status, "unconfirmed");
  assert.equal(closes, 1);
  assert.equal(leaseReleases, 0);
  assert.equal(await ownedCleanup(context.resources[1]!), first);
});

test("cleanup stop validation rejects hostile shapes without invoking hooks in factory or controller",
  async () => {
    let hooks = 0;
    const fakeSignal = Object.defineProperties({}, {
      aborted: { enumerable: true, get: () => { hooks += 1; return false; } },
      addEventListener: { enumerable: true, value: () => { hooks += 1; } },
      removeEventListener: { enumerable: true, value: () => { hooks += 1; } },
    });
    const signalProxy = new Proxy(new AbortController().signal, {
      getPrototypeOf: (target) => { hooks += 1; return Reflect.getPrototypeOf(target); },
      get: (target, key, receiver) => { hooks += 1; return Reflect.get(target, key, receiver); },
    });
    const stopProxy = new Proxy({ signal: new AbortController().signal,
      deadlineAt: performance.now() + 1_000 }, {
      ownKeys: (target) => { hooks += 1; return Reflect.ownKeys(target); },
    });
    const getterStop = Object.defineProperty({ deadlineAt: performance.now() + 1_000 }, "signal", {
      enumerable: true, get: () => { hooks += 1; return new AbortController().signal; },
    });
    const hostile = [
      { signal: fakeSignal, deadlineAt: performance.now() + 1_000 },
      { signal: signalProxy, deadlineAt: performance.now() + 1_000 },
      stopProxy,
      getterStop,
    ];
    for (const value of hostile) {
      assert.throws(() => new BrowserAcquisitionController("page", { submit: () => undefined }, 10,
        value as never), /cleanup stop|native AbortSignal/);
      await assert.rejects(createBrowserSurfaceFactory(backend(async (_requirement, call) => {
        call.beforeSubmit(); return session();
      }), { cleanupStop: value as never }).setup(requirement(), setupContext().value),
      code("invalidRequest"));
    }
    assert.equal(hooks, 0);
  });

test("native AbortSignal intrinsics ignore shadowed state and listeners while real abort holds lease",
  async () => {
    let hooks = 0;
    let leaseReleases = 0;
    const stop = new AbortController();
    Object.defineProperties(stop.signal, {
      aborted: { configurable: true, value: false },
      addEventListener: { configurable: true, value: () => { hooks += 1; } },
      removeEventListener: { configurable: true, value: () => { hooks += 1; } },
    });
    const close = deferred<BrowserCloseProof>();
    const context = setupContext();
    await createBrowserSurfaceFactory(backend(async (_requirement, call) => {
      call.beforeSubmit();
      return session({ close: () => close.promise });
    }), { cleanupTimeoutMs: 1_000,
      cleanupStop: { signal: stop.signal, deadlineAt: performance.now() + 2_000 }, lease: {
        id: "lease-authentic-stop",
        release: async () => { leaseReleases += 1; return { status: "released" }; },
      } }).setup(requirement(), context.value);
    const pending = ownedCleanup(context.resources[1]!);
    await Promise.resolve();
    stop.abort(new Error("real outer abort"));
    const receipt = await pending;
    assert.equal(receipt.status, "unconfirmed");
    close.resolve(proof());
    await delay(1);
    assert.equal((await ownedCleanup(context.resources[0]!)).status, "unconfirmed");
    assert.equal(leaseReleases, 0);
    assert.equal(hooks, 0);
  });

test("ordinary native cleanup stop signal still permits confirmed close and lease release", async () => {
  let leaseReleases = 0;
  const stop = new AbortController();
  const context = setupContext();
  await createBrowserSurfaceFactory(backend(async (_requirement, call) => {
    call.beforeSubmit(); return session();
  }), { cleanupTimeoutMs: 100,
    cleanupStop: { signal: stop.signal, deadlineAt: performance.now() + 1_000 }, lease: {
      id: "lease-ordinary-stop",
      release: async () => { leaseReleases += 1; return { status: "released" }; },
    } }).setup(requirement(), context.value);
  assert.equal((await ownedCleanup(context.resources[1]!)).status, "released");
  assert.equal((await ownedCleanup(context.resources[0]!)).status, "released");
  assert.equal(leaseReleases, 1);
});

test("single cleanup deadline covers acquisition settlement and late acquisition closes at most once",
  async () => {
    let now = 0;
    let closes = 0;
    const acquired = deferred<BrowserSurfaceSessionPort>();
    const controller = new BrowserAcquisitionController("page", { submit: () => undefined }, 10,
      undefined, () => now);
    controller.watch(acquired.promise, { submitted: true, signal: new AbortController().signal,
      beforeSubmit: () => ({ signal: new AbortController().signal, timeoutMs: 1 }) });
    const cleanup = controller.cleanup();
    now = 11;
    const first = await cleanup;
    assert.equal(first.status, "unconfirmed");
    acquired.resolve(session({ close: async () => { closes += 1; return proof(); } }));
    await delay(1);
    assert.equal(closes, 1);
    assert.equal(await controller.cleanup(), first);
    assert.equal(controller.leaseReleaseAllowed(), false);
  });

test("same-tick close proof at the absolute cleanup deadline cannot become released", async () => {
  let now = 0;
  const controller = new BrowserAcquisitionController("page", { submit: () => undefined }, 10,
    undefined, () => now);
  controller.watch(Promise.resolve(session({ close: async () => {
    now = 10; return proof();
  } })), { submitted: true, signal: new AbortController().signal,
    beforeSubmit: () => ({ signal: new AbortController().signal, timeoutMs: 1 }) });
  const receipt = await controller.cleanup();
  assert.equal(receipt.status, "unconfirmed");
  assert.equal(controller.leaseReleaseAllowed(), false);
  assert.equal(await controller.cleanup(), receipt);
});

function requirement() {
  return { kind: "browser" as const, surfaceId: "page", expectedHostId: "host-1",
    capabilities: ["browser.dom"], engine: "chromium" as const, timeoutMs: 100 };
}

function backend(launch: BrowserSurfaceBackendPort["launch"]): BrowserSurfaceBackendPort {
  return { hostId: "host-1", capabilities: ["browser.dom"], launch };
}

function session(overrides: Partial<BrowserSurfaceSessionPort> = {}): BrowserSurfaceSessionPort {
  return { identity: { hostId: "host-1", sessionId: "session-1" },
    invoke: async (_action, call) => { call.beforeSubmit(); return null; },
    close: async () => proof(), ...overrides };
}

function proof(): BrowserCloseProof {
  return { kind: "browserSessionClosed", hostId: "host-1", sessionId: "session-1" };
}

function cleanupStop() {
  return { signal: new AbortController().signal, deadlineAt: performance.now() + 1_000 };
}

function setupContext(options: { signal?: AbortSignal; scope?: ResourceScope;
  evidence?: (event: SurfaceEvidenceEvent) => void; remainingMs?: () => number;
  deadlineAt?: number } = {}) {
  const resources: ResourceRegistration[] = [];
  const value: SurfaceSetupContext = {
    signal: options.signal ?? new AbortController().signal,
    deadlineAt: options.deadlineAt ?? performance.now() + 1_000,
    remainingMs: options.remainingMs ?? (() => 1_000),
    dispatch: async (effect, action) => action(effect),
    registerResource: (resource) => {
      resources.push(resource);
      options.scope?.register(resource);
    },
    evidence: { submit: options.evidence ?? (() => undefined) },
  };
  return { value, resources };
}

async function ownedCleanup(registration: ResourceRegistration) {
  if (registration.ownership !== "owned") throw new Error("Expected owned registration.");
  return registration.cleanup();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function code(expected: SurfaceProviderError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof SurfaceProviderError && error.code === expected;
}
