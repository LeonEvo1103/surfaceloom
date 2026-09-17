import assert from "node:assert/strict";
import test from "node:test";
import {
  GuardedElementActions,
  type ElementActionBackend,
  type ElementReference,
  type ResolvedElementAction,
} from "../src/index.js";

const locator = Object.freeze({ key: "submit", role: "button" as const });
const reference = Object.freeze({ id: "element-1", locator });

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("independent action signals cannot cancel a concurrent invocation", async () => {
  const firstResolution = deferred<ElementReference>();
  const secondResolution = deferred<ElementReference>();
  const resolutions = [firstResolution, secondResolution];
  const performed: ResolvedElementAction[] = [];
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: ["attached", "unique", "visible", "enabled"],
    resolveActionability: () => resolutions.shift()!.promise,
    performResolvedAction: async (action) => { performed.push(action); },
  };
  const actions = GuardedElementActions.fromBackend(backend);
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = actions.invoke(locator, { signal: first.signal });
  const successful = actions.invoke(locator, { signal: second.signal });

  first.abort(new Error("first only"));
  firstResolution.resolve(reference);
  await assert.rejects(cancelled, /first only/);
  secondResolution.resolve(reference);
  await successful;
  assert.equal(performed.length, 1);
});

test("abort in the resolution-to-submit seam prevents perform", async () => {
  const controller = new AbortController();
  let writes = 0;
  const seamReference = {
    get id(): string {
      controller.abort(new Error("seam abort"));
      return "element-1";
    },
    locator,
  };
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: ["attached", "unique", "visible", "enabled"],
    resolveActionability: async () => seamReference,
    performResolvedAction: async (_action, context) => {
      assert.equal(context?.signal, controller.signal);
      writes += 1;
    },
  };
  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator, { signal: controller.signal }),
    /seam abort/,
  );
  assert.equal(writes, 0);
});

test("a legacy one-argument backend remains source compatible", async () => {
  let writes = 0;
  const legacy: ElementActionBackend = {
    supportedActionabilityChecks: ["attached", "unique", "visible", "enabled"],
    resolveActionability: async () => reference,
    performResolvedAction: async (_action) => { writes += 1; },
  };
  await GuardedElementActions.fromBackend(legacy).invoke(locator);
  assert.equal(writes, 1);
});

test("signal validation rejects duck types without reading hostile accessors", async () => {
  let reads = 0;
  let resolutions = 0;
  const fake = Object.defineProperty({}, "aborted", {
    get(): boolean { reads += 1; throw new Error("hostile getter"); },
  }) as AbortSignal;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: ["attached", "unique", "visible", "enabled"],
    resolveActionability: async () => { resolutions += 1; return reference; },
    performResolvedAction: async () => undefined,
  };
  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator, { signal: fake }),
    /native AbortSignal/,
  );
  assert.equal(reads, 0);
  assert.equal(resolutions, 0);
});

test("native signal checks ignore a shadowed aborted accessor", async () => {
  let reads = 0;
  const signal = new AbortController().signal;
  Object.defineProperty(signal, "aborted", {
    get(): boolean { reads += 1; throw new Error("must not execute"); },
  });
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: ["attached", "unique", "visible", "enabled"],
    resolveActionability: async () => reference,
    performResolvedAction: async () => undefined,
  };
  await GuardedElementActions.fromBackend(backend).invoke(locator, { signal });
  assert.equal(reads, 0);
});

test("real-signal proxies and revoked proxies are rejected without traps", async () => {
  let traps = 0;
  const proxy = new Proxy(new AbortController().signal, {
    get(): never { traps += 1; throw new Error("trap"); },
  });
  const revoked = Proxy.revocable(new AbortController().signal, {});
  revoked.revoke();
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: ["attached", "unique", "visible", "enabled"],
    resolveActionability: async () => reference,
    performResolvedAction: async () => undefined,
  };
  for (const signal of [proxy, revoked.proxy]) {
    await assert.rejects(
      GuardedElementActions.fromBackend(backend).invoke(locator, { signal }),
      /non-Proxy AbortSignal/,
    );
  }
  assert.equal(traps, 0);
});
