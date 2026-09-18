const approvalLocators = Object.freeze({
  "approval.approve": Object.freeze({ role: "button", name: "Approve", exact: true }),
  "approval.deny": Object.freeze({ role: "button", name: "Deny", exact: true }),
});

/**
 * Product adapter from the richer legacy locator to the intentionally smaller v3 SPI.
 * Only the two known approval buttons use stable test IDs; arbitrary role locators are
 * rejected instead of silently losing their accessible name.
 */
export function toV3Locator(input) {
  if (input.kind === "role") {
    const canonical = approvalLocators[input.key];
    if (canonical === undefined || input.role !== canonical.role || input.name !== canonical.name
        || input.exact !== canonical.exact) {
      throw new Error(`No lossless v3 locator mapping exists for role locator ${input.key}.`);
    }
    return Object.freeze({ kind: "testId", key: input.key, value: input.key });
  }
  if (!["testId", "label", "text", "css"].includes(input.kind)
      || typeof input.value !== "string") {
    throw new Error(`Unsupported reference-agent locator ${String(input.kind)}.`);
  }
  return Object.freeze({ kind: input.kind, key: input.key, value: input.value });
}

export function v3Session(surface) {
  return Object.freeze({
    navigate: (url, options = {}) => surface.perform({ kind: "navigate", url }, options),
    click: (target, options = {}) =>
      surface.perform({ kind: "click", locator: toV3Locator(target) }, options),
    waitFor: (target, state, options = {}) => {
      if (state !== "visible") throw new Error("The showcase only waits for visible targets.");
      return surface.perform({ kind: "waitVisible", locator: toV3Locator(target) }, options);
    },
    text: (target, options = {}) =>
      surface.perform({ kind: "readText", locator: toV3Locator(target) }, options),
  });
}
