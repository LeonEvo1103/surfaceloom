import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "ok";
const marker = process.argv[3];
if (mode === "startup-marker" && marker !== undefined) appendFileSync(marker, "started\n");
if (mode === "inherited-stdio") {
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], {
    stdio: ["ignore", process.stdout, process.stderr],
  }).unref();
}
const methods = [
  ["host.handshake", "observe", ["bootstrap"]],
  ["capabilities.get", "observe", ["host"]],
  ["session.launch", "lifecycle", ["host"]],
  ["session.attach", "lifecycle", ["host"]],
  ["session.release", "lifecycle", ["session"]],
  ["session.close", "lifecycle", ["session"]],
  ["session.terminate", "lifecycle", ["session"]],
  ["element.find", "observe", ["session", "handle"]],
  ["element.get", "observe", ["handle"]],
  ["element.action", "mutate", ["handle"]],
].map(([name, intent, scopeKinds]) => ({ name, intent, scopeKinds }));
const featureNames = ["application.launch", "application.attach", "application.gracefulClose",
  "application.terminateOwned", "uia.locator", "uia.stableElementHandles", "uia.elementState",
  "uia.semanticActions", "uia.checkedActionTarget"];
const features = Object.fromEntries(featureNames.map((name) =>
  [name, { support: "supported", summary: `${name} scripted fixture` }]));
const hostInstanceId = "windows-scripted-host";
const sessionId = "windows-scripted-session";
const rootHandleId = "root-handle";
const elementHandleId = "field-handle";
let pending = "";
let active = true;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline).replace(/\r$/u, "");
    pending = pending.slice(newline + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    if (request.type === "cancel") continue;
    handle(request);
  }
});

function handle(request) {
  const name = request.call.name;
  if (name === "host.handshake") {
    const descriptor = { hostInstanceId, platform: mode === "wrong-platform" ? "macos" : "windows",
      backend: "uia", methods: mode === "missing-action"
        ? methods.filter((item) => item.name !== "element.action") : methods, maxMessageBytes: 1048576 };
    return success(request, descriptor, null);
  }
  if (name === "capabilities.get") {
    return success(request, { protocolVersion: "1.0", platform: "windows",
      backend: "windows-ui-automation", methods: methods.map((item) => item.name),
      locatorFields: ["automationIds", "names", "controlTypes", "classNames", "frameworkIds",
        "nativeWindowHandle"], controlTypes: ["window", "edit", "button"],
      actionRequirements: { invoke: "InvokePattern", setValue: "ValuePattern" }, features }, null);
  }
  if (name === "session.launch" || name === "session.attach") {
    active = true;
    const respond = () => success(request, { hostInstanceId, sessionId,
      ownership: name === "session.launch" ? "owned" : "borrowed",
      surface: "application", root: { hostInstanceId, sessionId, handleId: rootHandleId } }, receipt(request));
    if (mode === "late-acquisition") return setTimeout(respond, 30);
    return respond();
  }
  if (!active) return failure(request, "session_not_found", "notFound", "Session is inactive.");
  if (name === "element.get") return success(request,
    element(mode === "wrong-get-handle" ? "foreign-handle" : request.call.scope.handleId, "window"), null);
  if (name === "element.find") {
    const locator = request.call.payload.locator;
    if (!strictLocator(locator)) return failure(request, "invalid_request", "invalidRequest", "Locator is not strict.");
    if (mode === "ambiguous-find") {
      return failure(request, "ambiguous_match", "conflict", "Locator matched multiple elements.");
    }
    if (mode === "slow-find") return setTimeout(() =>
      success(request, element(elementHandleId, "edit"), null), 30);
    return success(request, element(elementHandleId, "edit"), null);
  }
  if (name === "element.action") {
    if (marker !== undefined) appendFileSync(marker, "element.action\n");
    const expected = request.call.payload.expectedTarget;
    if (request.call.scope.handleId !== elementHandleId || expected?.rootElementId !== rootHandleId
        || expected?.processId !== 4242 || !strictLocator(expected?.locator)) {
      return failure(request, "action_target_changed", "conflict", "Expected target mismatch.");
    }
    if (mode === "unknown-action") {
      return failure(request, "deadline_exceeded", "deadline", "Scripted post-submit timeout.", "unknown");
    }
    if (mode === "slow-action") return setTimeout(() =>
      success(request, element(elementHandleId, "edit"), receipt(request)), 30);
    return success(request, element(elementHandleId, "edit"), receipt(request));
  }
  if (name === "session.close" || name === "session.terminate") {
    if (marker !== undefined) appendFileSync(marker, `${name}\n`);
    if (mode === "unknown-end") {
      return failure(request, "deadline_exceeded", "deadline", "Scripted end outcome is unknown.", "unknown");
    }
    active = false;
    return success(request, { sessionId: mode === "bad-end-proof" ? "wrong-session" : sessionId, processId: 4242,
      requestedAction: mode === "bad-end-action" ? "close"
        : name === "session.close" ? "close" : "terminate",
      ...(mode === "bad-end-pid" ? { processId: 9999 } : {}),
      exited: true, wasAlreadyExited: false }, receipt(request));
  }
  if (name === "session.release") {
    active = false;
    return success(request, { released: true, sessionId }, receipt(request));
  }
  return failure(request, "method_not_found", "unsupported", "Unknown scripted method.");
}

function element(handleId, controlType) {
  return { handle: { hostInstanceId, sessionId, handleId }, snapshot: {
    elementId: handleId, name: controlType === "window" ? "Fixture" : "Name",
    automationId: controlType === "window" ? "fixture.window" : "fixture.name",
    controlType, className: "FixtureClass", frameworkId: "WPF",
    processId: mode === "wrong-pid" ? 9999 : 4242,
    nativeWindowHandle: 120, isEnabled: true, isOffscreen: false, value: controlType === "edit" ? "value" : null,
    hasKeyboardFocus: false, isSelected: null, toggleState: null, expandCollapseState: null,
    ariaRole: null, ariaProperties: null, isReadOnly: false,
    supportedActions: controlType === "edit" ? ["setValue"] : [] } };
}

function strictLocator(locator) {
  if (locator === null || typeof locator !== "object" || locator.matchIndex !== null) return false;
  const arrays = [locator.automationIds, locator.names, locator.controlTypes, locator.classNames, locator.frameworkIds];
  return arrays.every(Array.isArray) && arrays.reduce((sum, item) => sum + item.length, 0)
    + (locator.nativeWindowHandle === null ? 0 : 1) > 0;
}

function receipt(request, outcome = "executed") {
  return { operationId: request.call.operationId, outcome };
}
function envelope(request, body) {
  process.stdout.write(`${JSON.stringify({ protocol: "surfaceloom.native",
    version: mode === "wrong-version" ? "9.9" : "1.0",
    type: "response", id: request.id, ...body })}\n`);
}
function success(request, result, operation) { envelope(request, { ok: true, result, operation }); }
function failure(request, code, category, message, outcome = "notExecuted") {
  envelope(request, { ok: false, error: { code, category, message,
    retry: request.call.intent !== "observe" && outcome === "notExecuted" ? "safe" : "never" },
    operation: request.call.intent === "observe" ? null : receipt(request, outcome) });
}
