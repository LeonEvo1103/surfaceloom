import assert from "node:assert/strict";
import test from "node:test";

import {
  defineFixture,
  FixtureRegistry,
  FixtureRuntime,
} from "../src/index.js";

test("resolves only requested fixtures and tears down test before worker scope", async () => {
  const events: string[] = [];
  const host = defineFixture({
    id: "driver-host",
    scope: "worker",
    setup: () => {
      events.push("host.setup");
      return { value: "host", teardown: () => events.push("host.teardown") };
    },
  });
  const unused = defineFixture({
    id: "unused",
    setup: () => {
      events.push("unused.setup");
      return { value: true };
    },
  });
  const session = defineFixture({
    id: "app-session",
    dependencies: [host],
    setup: (context) => {
      events.push(`session.setup:${context.get(host)}`);
      return { value: "session", teardown: () => events.push("session.teardown") };
    },
  });

  const worker = new FixtureRuntime("worker");
  const testScope = worker.createTestScope();
  assert.equal(await testScope.use(session), "session");
  assert.equal(await testScope.use(session), "session");
  void unused;
  assert.deepEqual(events, ["host.setup", "session.setup:host"]);

  await testScope.close();
  await worker.close();
  assert.deepEqual(events, [
    "host.setup",
    "session.setup:host",
    "session.teardown",
    "host.teardown",
  ]);
});

test("rolls back dependencies created for a failed fixture setup", async () => {
  const events: string[] = [];
  const dependency = defineFixture({
    id: "temporary-profile",
    setup: () => ({
      value: "/tmp/profile",
      teardown: () => events.push("profile.teardown"),
    }),
  });
  const failing = defineFixture({
    id: "failing-session",
    dependencies: [dependency],
    setup: () => {
      throw new Error("launch failed");
    },
  });

  const runtime = new FixtureRuntime();
  await assert.rejects(runtime.use(failing), /launch failed/);
  assert.deepEqual(events, ["profile.teardown"]);
  await runtime.close();
});

test("serializes concurrent setup and rejects undeclared fixture reads", async () => {
  let setupCount = 0;
  const dependency = defineFixture({
    id: "shared",
    setup: async () => {
      setupCount += 1;
      await Promise.resolve();
      return { value: "shared" };
    },
  });
  const invalidConsumer = defineFixture({
    id: "invalid-consumer",
    setup: (context) => ({ value: context.get(dependency) }),
  });
  const runtime = new FixtureRuntime();

  assert.deepEqual(
    await Promise.all([runtime.use(dependency), runtime.use(dependency)]),
    ["shared", "shared"],
  );
  assert.equal(setupCount, 1);
  await assert.rejects(runtime.use(invalidConsumer), /not a declared dependency/);
  await runtime.close();
});

test("a concurrent setup failure cannot roll back an earlier successful fixture", async () => {
  const events: string[] = [];
  const stable = defineFixture({
    id: "stable",
    setup: () => {
      events.push("stable.setup");
      return { value: "stable", teardown: () => events.push("stable.teardown") };
    },
  });
  const failing = defineFixture({
    id: "failing",
    setup: () => {
      throw new Error("expected failure");
    },
  });
  const runtime = new FixtureRuntime();

  const results = await Promise.allSettled([
    runtime.use(stable),
    runtime.use(failing),
  ]);
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  assert.equal(await runtime.use(stable), "stable");
  assert.deepEqual(events, ["stable.setup"]);

  await runtime.close();
  assert.deepEqual(events, ["stable.setup", "stable.teardown"]);
});

test("worker close waits for teardown and refuses to outlive child scopes", async () => {
  const worker = new FixtureRuntime("worker");
  let releaseTeardown: (() => void) | undefined;
  let markTeardownStarted: (() => void) | undefined;
  const teardownStarted = new Promise<void>((resolve) => {
    markTeardownStarted = resolve;
  });
  const workerFixture = defineFixture({
    id: "host",
    scope: "worker",
    setup: () => ({
      value: "host",
      teardown: () => {
        markTeardownStarted?.();
        return new Promise<void>((resolve) => {
          releaseTeardown = resolve;
        });
      },
    }),
  });
  const testScope = worker.createTestScope();
  await testScope.use(workerFixture);

  await assert.rejects(worker.close(), /Close all test fixture scopes/);
  await testScope.close();
  const firstClose = worker.close();
  const secondClose = worker.close();
  assert.equal(firstClose, secondClose);
  await teardownStarted;

  let secondCloseSettled = false;
  void secondClose.then(() => {
    secondCloseSettled = true;
  });
  await Promise.resolve();
  assert.equal(secondCloseSettled, false);
  releaseTeardown?.();
  await firstClose;
  assert.equal(secondCloseSettled, true);

  assert.throws(() => worker.createTestScope(), /closing or closed/);
  await assert.rejects(testScope.use(workerFixture), /closing or closed/);
});

test("fixture registry resolves manifest ids and fails fast for missing setup", () => {
  const definition = defineFixture({
    id: "agent.scripted-run",
    setup: () => ({ value: "script" }),
  });
  const registry = new FixtureRegistry([definition]);

  assert.deepEqual(registry.listIds(), ["agent.scripted-run"]);
  assert.equal(registry.require("agent.scripted-run"), definition);
  assert.throws(
    () => registry.resolve(["agent.side-effect-probe"]),
    /No executable fixture is registered/,
  );
  assert.throws(
    () =>
      registry.validateComponentManifests([
        {
          id: "desktop.agent.approval",
          requiredFixtures: ["agent.side-effect-probe"],
        } as never,
      ]),
    /requires unregistered fixture/,
  );
});
