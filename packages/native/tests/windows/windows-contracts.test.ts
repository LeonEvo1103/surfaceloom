import assert from "node:assert/strict";
import test from "node:test";

import { NativeClient } from "../../src/client/client.js";
import type { NativeCodecContext } from "../../src/client/codec.js";
import type { HostDescriptor, NativeWireMessage, WireRequest } from "../../src/contracts.js";
import { validateWireMessage } from "../../src/schema.js";
import { windowsElementTupleCodec } from "../../src/windows/codecs.js";
import type { WindowsUiaLocator } from "../../src/windows/contracts.js";
import { WindowsNativeError } from "../../src/windows/error.js";
import { WindowsDesktopSessionState } from "../../src/windows/session.js";
import { strictLocator } from "../../src/windows/validation.js";
import { FakeNativeTransport, ManualRuntime } from "../client/fake-transport.js";

const locator: WindowsUiaLocator = { automationIds: ["field"], names: [], controlTypes: ["edit"],
  classNames: [], frameworkIds: [], nativeWindowHandle: null, scope: "descendants", matchIndex: null };

test("locator codec rejects empty, indexed, extra-field, and hostile shapes", () => {
  assert.throws(() => strictLocator({ ...locator, automationIds: [], controlTypes: [] }), /stable selector/u);
  assert.throws(() => strictLocator({ ...locator, matchIndex: 0 }), /matchIndex/u);
  assert.throws(() => strictLocator({ ...locator, extra: true } as never), /unknown fields/u);
  let traps = 0;
  const proxy = new Proxy(locator, { get: (target, key, receiver) => {
    traps += 1; return Reflect.get(target, key, receiver);
  } });
  assert.throws(() => strictLocator(proxy), /plain data/u);
  assert.equal(traps, 0);
});

test("element codec rejects foreign handles and malformed snapshots", () => {
  const codec = windowsElementTupleCodec({ hostInstanceId: "host", sessionId: "session" });
  const context: NativeCodecContext = { trackSession: (value) => value, trackHandle: (value) => value };
  assert.throws(() => codec.decode(element("foreign", "session") as never, context), /belong/u);
  const malformed = element("host", "session") as { snapshot: Record<string, unknown> };
  malformed.snapshot.extra = true;
  assert.throws(() => codec.decode(malformed as never, context), /unknown fields/u);
  const bound = windowsElementTupleCodec({ hostInstanceId: "host", sessionId: "session" },
    { hostInstanceId: "host", sessionId: "session", handleId: "requested" });
  assert.throws(() => bound.decode(element("host", "session") as never, context), /requested handle/u);
});

test("an expired shared deadline after strict find sends zero action requests", async () => {
  const runtime = new ManualRuntime();
  let actions = 0;
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") current.receive(success(message, host));
    else if (message.call.name === "element.find") {
      current.receive(success(message, element("host", "session")));
      runtime.nowValue = 10;
    } else if (message.call.name === "element.action") actions += 1;
  });
  const client = new NativeClient({ transport, runtime });
  await client.connect(100);
  const descriptor = client.trackSession({ hostInstanceId: "host", sessionId: "session", ownership: "owned",
    surface: "application", root: { hostInstanceId: "host", sessionId: "session", handleId: "root" } });
  const session = new WindowsDesktopSessionState(client, { descriptor, root: snapshot("root"),
    configuredProcessId: null, acquisitionReceipt: { operationId: "launch", outcome: "executed" } },
  ["ui.invoke"], runtime.now);
  await assert.rejects(session.invoke(locator, { timeoutMs: 5 }), (error: unknown) =>
    error instanceof WindowsNativeError && error.code === "deadline");
  assert.equal(actions, 0);
  await client.close();
});

const host: HostDescriptor = { hostInstanceId: "host", platform: "windows", backend: "uia",
  maxMessageBytes: 1_048_576, methods: [
    { name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] },
    { name: "element.find", intent: "observe", scopeKinds: ["session"] },
    { name: "element.action", intent: "mutate", scopeKinds: ["handle"] },
  ] };

function success(request: WireRequest, result: unknown): NativeWireMessage {
  return validateWireMessage({ protocol: "surfaceloom.native", version: "1.0", type: "response",
    id: request.id, ok: true, result,
    operation: request.call.intent === "observe" ? null
      : { operationId: request.call.operationId, outcome: "executed" } });
}
function element(hostInstanceId: string, sessionId: string): unknown {
  return { handle: { hostInstanceId, sessionId, handleId: "field" }, snapshot: snapshot("field") };
}
function snapshot(elementId: string): Record<string, unknown> {
  return { elementId, name: "Name", automationId: "field", controlType: "edit", className: "Fixture",
    frameworkId: "WPF", processId: 42, nativeWindowHandle: 1, isEnabled: true, isOffscreen: false,
    value: "value", hasKeyboardFocus: false, isSelected: null, toggleState: null,
    expandCollapseState: null, ariaRole: null, ariaProperties: null, isReadOnly: false,
    supportedActions: ["setValue"] };
}
