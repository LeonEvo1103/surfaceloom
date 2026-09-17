import assert from "node:assert/strict";
import test from "node:test";
import type { CaseContext } from "../../src/contracts.js";
import { createNativeCallContext } from "../../src/native-binding/call-context.js";
import { NativeBindingError } from "../../src/native-binding/contracts.js";

function contextWith(signal: AbortSignal, remainingMs: () => number): CaseContext {
  return { signal, remainingMs, throwIfCancelled: () => undefined,
    acknowledgeCancellation: () => false, fixture: () => { throw new Error("unused"); },
    step: async (_step, body) => body(), criterion: async (_id, check) => check(),
    registerResource: () => undefined, dispatch: async (_effect, action) => action(_effect) } as CaseContext;
}

test("call context uses a fixed absolute explicit deadline and current case budget", () => {
  const controller = new AbortController();
  let remaining = 40;
  let now = 10;
  const call = createNativeCallContext(contextWith(controller.signal, () => remaining),
    { timeoutMs: 30 }, () => now);
  remaining = 15;
  now = 20;
  assert.equal(call.beforeSubmit().timeoutMs, 15);
  now = 41;
  assert.throws(() => call.beforeSubmit(), isCode("deadline"));
  controller.abort();
  assert.throws(() => call.beforeSubmit(), isCode("aborted"));
  call.dispose();
});

test("native signals ignore shadowed instance accessors", () => {
  const controller = new AbortController();
  let traps = 0;
  Object.defineProperty(controller.signal, "aborted", { get: () => { traps += 1; throw new Error("trap"); } });
  Object.defineProperty(controller.signal, "addEventListener", { get: () => { traps += 1; throw new Error("trap"); } });
  const call = createNativeCallContext(contextWith(new AbortController().signal, () => 100),
    { signal: controller.signal, timeoutMs: 50 }, () => 0);
  assert.equal(call.beforeSubmit().timeoutMs, 50);
  assert.equal(traps, 0);
  call.dispose();
});

test("ordinary and revoked AbortSignal proxies are rejected with zero traps", () => {
  for (const signal of [countingProxy(), revokedProxy()]) {
    assert.throws(() => createNativeCallContext(
      contextWith(new AbortController().signal, () => 100), { signal: signal.value }), isCode("aborted"));
    assert.equal(signal.traps(), 0);
  }
});

function countingProxy(): { value: AbortSignal; traps: () => number } {
  let count = 0;
  const value = new Proxy(new AbortController().signal, { get: (target, key, receiver) => {
    count += 1; return Reflect.get(target, key, receiver);
  } });
  return { value, traps: () => count };
}
function revokedProxy(): { value: AbortSignal; traps: () => number } {
  let count = 0;
  const revocable = Proxy.revocable(new AbortController().signal, { get: () => { count += 1; return undefined; } });
  revocable.revoke();
  return { value: revocable.proxy, traps: () => count };
}
function isCode(code: NativeBindingError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof NativeBindingError && error.code === code;
}
