import assert from "node:assert/strict";
import test from "node:test";
import { ResourceScope, type ResourceCleanupReceipt, type ResourceRegistration, type ResourceScopeOptions } from "../src/resources.js";

test("registration accessors are rejected without invocation and later cleanup remains possible", async () => {
  for (const field of ["id", "ownership", "cleanup"]) {
    const scope = new ResourceScope();
    let reads = 0;
    const input = Object.defineProperty({ id: "hostile", ownership: "owned", cleanup: () => ({ status: "released" }) },
      field, { get: () => { reads += 1; throw new Error("getter executed"); } });
    assert.throws(() => scope.register(input as ResourceRegistration), /data properties/);
    scope.register({ id: "valid", ownership: "owned", cleanup: () => ({ status: "released" }) });
    const result = await scope.close();
    assert.equal(reads, 0);
    assert.equal(result.status, "failed");
    assert.equal(result.outcomes[0]?.status, "released");
  }
});

test("borrowed cleanup cannot be supplied or executed", async () => {
  const scope = new ResourceScope();
  let invoked = false;
  assert.throws(() => scope.register({ id: "borrowed", ownership: "borrowed", cleanup: () => {
    invoked = true; return { status: "released" };
  } } as unknown as ResourceRegistration), /borrowed resources cannot/);
  assert.equal((await scope.close()).status, "failed");
  assert.equal(invoked, false);
});

test("throwing descriptor proxies fail closed while preserving earlier failure and cleanup", async () => {
  const scope = new ResourceScope();
  scope.recordFailure("setup", new Error("earliest setup failure"));
  scope.register({ id: "valid", ownership: "owned", cleanup: () => ({ status: "released" }) });
  assert.throws(() => scope.register(new Proxy({ id: "hostile", ownership: "borrowed" }, {
    ownKeys: () => { throw new Error("descriptor trap failed"); },
  }) as ResourceRegistration));
  const result = await scope.close();
  assert.equal(result.primaryFailure?.message, "earliest setup failure");
  assert.equal(result.outcomes[0]?.status, "released");
  assert.equal(result.tainted, true);
});

test("descriptor reentry cannot register resources after close has begun", async () => {
  const scope = new ResourceScope();
  const input = new Proxy({ id: "late", ownership: "borrowed" }, {
    ownKeys: (target) => { void scope.close(); return Reflect.ownKeys(target); },
  });
  assert.throws(() => scope.register(input as ResourceRegistration), /no longer accepts/);
  const result = await scope.close();
  assert.equal(result.outcomes.length, 0);
  assert.equal(result.status, "failed");
});

test("error descriptor reentry cannot append an execution failure after close has begun", async () => {
  const scope = new ResourceScope();
  const error = new Proxy({ message: "late body failure" }, {
    getOwnPropertyDescriptor: (target, key) => {
      void scope.close();
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.throws(() => scope.recordFailure("body", error), /no longer accepts failure records/);
  const result = await scope.close();
  assert.equal(result.status, "failed");
  assert.equal(result.tainted, true);
  assert.deepEqual(result.failures.map(({ code }) => code), ["scopeClosed"]);
  assert.equal(result.primaryFailure?.phase, "failureRecording");
});

test("arbitrary thenables are rejected without running getters or then functions", async () => {
  let invoked = 0;
  const candidates = [
    { get then(): unknown { invoked += 1; throw new Error("then getter executed"); } },
    { then: (resolve: (value: unknown) => void) => { invoked += 1; resolve({ status: "released" }); throw new Error("after resolve"); } },
    { status: "released", get then(): unknown { invoked += 1; return undefined; } },
  ];
  for (const candidate of candidates) {
    const scope = new ResourceScope();
    scope.register({ id: "host", ownership: "owned", cleanup: () => ({ status: "released" }) });
    scope.register({ id: "thenable", ownership: "owned", cleanup: () => candidate as unknown as ResourceCleanupReceipt });
    const result = await scope.close();
    assert.equal(result.outcomes[0]?.status, "unconfirmed");
    assert.equal(result.outcomes[1]?.status, "released");
    assert.equal(result.tainted, true);
  }
  assert.equal(invoked, 0);
});

test("receipt accessors and revoked proxies cannot produce a released outcome", async () => {
  let reads = 0;
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  for (const value of [{ get status(): unknown { reads += 1; return "released"; } }, revocable.proxy]) {
    const scope = new ResourceScope();
    scope.register({ id: "invalid", ownership: "owned", cleanup: () => value as ResourceCleanupReceipt });
    const result = await scope.close();
    assert.equal(result.outcomes[0]?.status, "unconfirmed");
    assert.equal(result.primaryFailure?.code, "invalidCleanupReceipt");
  }
  assert.equal(reads, 0);
});

test("native promise then overrides are never called", async () => {
  const scope = new ResourceScope();
  let reads = 0;
  const promise = Promise.resolve<ResourceCleanupReceipt>({ status: "released" });
  Object.defineProperty(promise, "then", { get: () => { reads += 1; throw new Error("unsafe then getter"); } });
  scope.register({ id: "native", ownership: "owned", cleanup: () => promise });
  assert.equal((await scope.close()).status, "passed");
  assert.equal(reads, 0);
});

test("a throwing native promise species lookup cannot hide failure or skip remaining cleanup", async () => {
  const scope = new ResourceScope();
  const promise = Promise.resolve<ResourceCleanupReceipt>({ status: "released" });
  Object.defineProperty(promise, "constructor", { get: () => { throw new Error("unsafe promise species"); } });
  scope.register({ id: "host", ownership: "owned", cleanup: () => ({ status: "released" }) });
  scope.register({ id: "native", ownership: "owned", cleanup: () => promise });
  const result = await scope.close();
  assert.equal(result.status, "failed");
  assert.equal(result.tainted, true);
  assert.equal(result.outcomes[1]?.status, "released");
  assert.equal(result.primaryFailure?.message, "unsafe promise species");
});

test("hostile thrown errors cannot interrupt cleanup or execute message getters", async () => {
  const scope = new ResourceScope();
  let reads = 0;
  const thrown = Object.defineProperty(new Error(), "message", { get: () => { reads += 1; throw new Error("unsafe message getter"); } });
  scope.recordFailure("body", thrown);
  scope.register({ id: "first", ownership: "owned", cleanup: () => ({ status: "released" }) });
  scope.register({ id: "second", ownership: "owned", cleanup: () => { throw thrown; } });
  const result = await scope.close();
  assert.equal(result.primaryFailure?.phase, "body");
  assert.equal(result.outcomes[1]?.status, "released");
  assert.equal(result.failures.length, 2);
  assert.equal(reads, 0);
});

test("invalid options and ownership records fail closed without executing getters", async () => {
  for (const value of [null, -1, 0, Infinity, NaN, "10", 2_147_483_648]) {
    assert.throws(() => new ResourceScope({ cleanupTimeoutMs: value } as ResourceScopeOptions));
  }
  let reads = 0;
  assert.throws(() => new ResourceScope({ get cleanupTimeoutMs(): number { reads += 1; return 10; } }));
  assert.equal(reads, 0);
  for (const input of [{ id: "bad", ownership: "implicit" }, { id: "missing-cleanup", ownership: "owned" },
    { id: "space id", ownership: "borrowed" }, { id: "unknown-field", ownership: "borrowed", value: 1 }]) {
    const scope = new ResourceScope();
    assert.throws(() => scope.register(input as ResourceRegistration));
    assert.equal((await scope.close()).status, "failed");
  }
});
