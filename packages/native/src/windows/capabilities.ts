import type { HostDescriptor, NativeMethodDescriptor } from "../contracts.js";
import type { WindowsDesktopCapability, WindowsHostCapabilities } from "./contracts.js";

interface Requirement {
  readonly methods: readonly Readonly<{ name: string; intent: NativeMethodDescriptor["intent"];
    scopes: readonly NativeMethodDescriptor["scopeKinds"][number][] }>[];
  readonly features: readonly string[];
}

const requirements: Readonly<Record<WindowsDesktopCapability, Requirement>> = Object.freeze({
  "app.launch": requirement([["session.launch", "lifecycle", ["host"]]], ["application.launch"]),
  "app.attach": requirement([["session.attach", "lifecycle", ["host"]]], ["application.attach"]),
  "app.quit": requirement([["session.close", "lifecycle", ["session"]]], ["application.gracefulClose"]),
  "app.terminate": requirement([["session.terminate", "lifecycle", ["session"]]], ["application.terminateOwned"]),
  "ui.inspect": requirement([
    ["element.find", "observe", ["session", "handle"]],
    ["element.get", "observe", ["handle"]],
  ], ["uia.locator", "uia.stableElementHandles", "uia.elementState"]),
  "ui.invoke": requirement([
    ["element.find", "observe", ["session", "handle"]],
    ["element.get", "observe", ["handle"]],
    ["element.action", "mutate", ["handle"]],
  ], ["uia.semanticActions", "uia.checkedActionTarget"]),
  "ui.set-value": requirement([
    ["element.find", "observe", ["session", "handle"]],
    ["element.get", "observe", ["handle"]],
    ["element.action", "mutate", ["handle"]],
  ], ["uia.semanticActions", "uia.checkedActionTarget"]),
});

export function effectiveWindowsCapabilities(environment: readonly WindowsDesktopCapability[],
  host: HostDescriptor, capabilities: WindowsHostCapabilities): readonly WindowsDesktopCapability[] {
  const capabilityMethods = new Set(capabilities.methods);
  return Object.freeze(environment.filter((capability) => {
    const required = requirements[capability];
    return required.methods.every((expected) => capabilityMethods.has(expected.name)
      && host.methods.some((method) => method.name === expected.name
        && method.intent === expected.intent
        && expected.scopes.every((scope) => method.scopeKinds.includes(scope))))
      && required.features.every((feature) => capabilities.features[feature] === "supported"
        || capabilities.features[feature] === "conditional");
  }));
}

function requirement(methods: readonly (readonly [string, NativeMethodDescriptor["intent"],
  readonly NativeMethodDescriptor["scopeKinds"][number][]])[], features: readonly string[]): Requirement {
  return Object.freeze({ methods: Object.freeze(methods.map(([name, intent, scopes]) =>
    Object.freeze({ name, intent, scopes: Object.freeze([...scopes]) }))), features: Object.freeze([...features]) });
}
