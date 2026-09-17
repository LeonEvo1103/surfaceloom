import type { EffectDescriptor } from "../effects.js";
import type { BrowserAction } from "./contracts.js";

export const browserLaunchEffect: EffectDescriptor = Object.freeze({
  resource: "browser.session",
  operation: "execute",
  boundary: "local",
  securitySensitive: false,
  recovery: "unknown",
});

export function browserActionEffect(action: BrowserAction): EffectDescriptor {
  const readOnly = action.kind === "readText" || action.kind === "waitVisible";
  return Object.freeze({
    resource: `browser.${action.kind}`,
    operation: readOnly ? "read" : "write",
    boundary: action.kind === "navigate" ? "external" : "local",
    securitySensitive: false,
    recovery: readOnly ? "notNeeded" : "unknown",
  });
}
