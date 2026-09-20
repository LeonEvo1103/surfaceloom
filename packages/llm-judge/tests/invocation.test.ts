import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeJudgeProvider,
  judge,
  JudgeContractError,
  type JudgeInvocation,
  type JudgeProvider,
} from "../src/index.js";
import { classified, request } from "./fixtures.js";

test("deadline and signal accessors are rejected without execution", async () => {
  let reads = 0;
  const invocation = {} as Record<string, unknown>;
  Object.defineProperty(invocation, "deadlineAt", {
    enumerable: true,
    get() { reads += 1; return Date.now() + 1_000; },
  });
  Object.defineProperty(invocation, "signal", {
    enumerable: true,
    get() { reads += 1; return undefined; },
  });
  const provider = new FakeJudgeProvider([{ kind: "return", output: classified() }]);
  await assert.rejects(
    () => judge(provider, request(), invocation as unknown as JudgeInvocation),
    JudgeContractError,
  );
  assert.equal(reads, 0);
  assert.equal(provider.calls.length, 0);
});

test("invocation Proxy traps are rejected without execution", async () => {
  let traps = 0;
  const invocation = new Proxy({ deadlineAt: Date.now() + 1_000 }, {
    get() { traps += 1; throw new Error("executed"); },
    ownKeys() { traps += 1; throw new Error("executed"); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error("executed"); },
  });
  const provider = new FakeJudgeProvider([{ kind: "return", output: classified() }]);
  await assert.rejects(() => judge(provider, request(), invocation), JudgeContractError);
  assert.equal(traps, 0);
  assert.equal(provider.calls.length, 0);
});

test("invocation requires a plain prototype and a genuine AbortSignal", async () => {
  const provider = new FakeJudgeProvider([{ kind: "return", output: classified() }]);
  const abnormal = Object.assign(Object.create({ inherited: true }), { deadlineAt: Date.now() + 1_000 });
  await assert.rejects(() => judge(provider, request(), abnormal), JudgeContractError);
  await assert.rejects(
    () => judge(provider, request(), { deadlineAt: Date.now() + 1_000, signal: {} as AbortSignal }),
    JudgeContractError,
  );
  assert.equal(provider.calls.length, 0);
});

test("mutating invocation after judge starts cannot extend its original deadline", async () => {
  const provider = new FakeJudgeProvider([{ kind: "waitForAbort" }]);
  const invocation: { deadlineAt: number; signal?: AbortSignal } = { deadlineAt: Date.now() + 25 };
  const pending = judge(provider, request(), invocation);
  invocation.deadlineAt = Date.now() + 60_000;
  const outcome = await pending;
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "deadlineExceeded");
  assert.equal(provider.calls.length, 1);
});

test("mutating invocation cannot shorten the snapshotted deadline before dispatch", async () => {
  const provider = new FakeJudgeProvider([{ kind: "return", output: classified() }]);
  const invocation = { deadlineAt: Date.now() + 5_000 };
  const pending = judge(provider, request(), invocation);
  invocation.deadlineAt = 0;
  const outcome = await pending;
  assert.equal(outcome.status, "classified");
});

test("signal replacement does not replace the snapshotted cancellation source", async () => {
  const oldController = new AbortController();
  const replacement = new AbortController();
  const provider = new FakeJudgeProvider([{ kind: "waitForAbort" }]);
  const invocation = { deadlineAt: Date.now() + 5_000, signal: oldController.signal };
  const pending = judge(provider, request(), invocation);
  invocation.signal = replacement.signal;
  replacement.abort();
  const state = await Promise.race([
    pending.then(() => "settled"),
    new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(state, "pending");
  oldController.abort();
  const outcome = await pending;
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "aborted");
});

test("completion removes the listener from the original signal", async () => {
  const controller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const provider: JudgeProvider = {
    name: "capture-signal",
    async judge(_input, context) {
      providerSignal = context.signal;
      return classified();
    },
  };
  const invocation = { deadlineAt: Date.now() + 5_000, signal: controller.signal };
  const outcome = await judge(provider, request(), invocation);
  assert.equal(outcome.status, "classified");
  controller.abort();
  await Promise.resolve();
  assert.equal(providerSignal?.aborted, false);
});
