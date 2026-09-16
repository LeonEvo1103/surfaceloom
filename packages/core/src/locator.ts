export const roles = [
  "application",
  "window",
  "dialog",
  "alert",
  "button",
  "checkBox",
  "radioButton",
  "switch",
  "textField",
  "textArea",
  "staticText",
  "link",
  "image",
  "comboBox",
  "slider",
  "progressIndicator",
  "menuBar",
  "menu",
  "menuItem",
  "toolbar",
  "tabGroup",
  "tab",
  "list",
  "listItem",
  "table",
  "row",
  "cell",
  "tree",
  "treeItem",
  "group",
  "scrollArea",
  "webArea",
  "other",
] as const;

export type Role = (typeof roles)[number];

export interface TextMatcher {
  readonly value: string;
  readonly mode?: "exact" | "contains" | "startsWith" | "regex";
  readonly caseSensitive?: boolean;
}

export type Scope =
  | { readonly kind: "desktop" }
  | { readonly kind: "application" }
  | { readonly kind: "activeWindow" }
  | { readonly kind: "window"; readonly window: Locator }
  | { readonly kind: "dialog"; readonly dialog: Locator }
  | { readonly kind: "element"; readonly elementId: string };

export type LocatorMatchPolicy =
  | { readonly kind: "strict" }
  | { readonly kind: "index"; readonly index: number };

export interface Locator {
  /** Project-owned semantic key used for diagnostics and adapter overrides. */
  readonly key: string;
  readonly role?: Role | readonly Role[];
  readonly name?: string | TextMatcher;
  /** Semantic identifier mapped by an adapter to AXIdentifier or AutomationId. */
  readonly identifier?: string;
  readonly description?: string | TextMatcher;
  readonly scope?: Scope;
  /** Defaults to strict: zero matches is missing and multiple matches is ambiguous. */
  readonly match?: LocatorMatchPolicy;
  /** @deprecated Prefer an explicit `match: { kind: "index", index }` policy. */
  readonly index?: number;
  readonly state?: Readonly<{
    enabled?: boolean;
    selected?: boolean;
    expanded?: boolean;
  }>;
}

export function defineLocator<const T extends Locator>(locator: T): Readonly<T> {
  if (locator.key.trim().length === 0) {
    throw new Error("A locator key must not be empty.");
  }
  if (locator.index !== undefined && (!Number.isInteger(locator.index) || locator.index < 0)) {
    throw new Error("A locator index must be a non-negative integer.");
  }
  if (locator.match !== undefined && locator.index !== undefined) {
    throw new Error("A locator cannot declare both match and deprecated index.");
  }
  const match = locator.match === undefined ? undefined : freezeMatchPolicy(locator.match);
  return Object.freeze({
    ...locator,
    ...(Array.isArray(locator.role)
      ? { role: Object.freeze([...locator.role]) }
      : {}),
    ...(typeof locator.name === "object"
      ? { name: Object.freeze({ ...locator.name }) }
      : {}),
    ...(typeof locator.description === "object"
      ? { description: Object.freeze({ ...locator.description }) }
      : {}),
    ...(locator.scope === undefined ? {} : { scope: freezeScope(locator.scope) }),
    ...(match === undefined ? {} : { match }),
    ...(locator.state === undefined
      ? {}
      : { state: Object.freeze({ ...locator.state }) }),
  }) as Readonly<T>;
}

export function resolveLocatorMatchPolicy(locator: Locator): LocatorMatchPolicy {
  if (locator.match !== undefined) return freezeMatchPolicy(locator.match);
  if (locator.index !== undefined) {
    return freezeMatchPolicy({ kind: "index", index: locator.index });
  }
  return Object.freeze({ kind: "strict" });
}

function freezeMatchPolicy(policy: LocatorMatchPolicy): LocatorMatchPolicy {
  const data = policy as { readonly kind?: unknown; readonly index?: unknown };
  if (data.kind === "strict") {
    if (data.index !== undefined) {
      throw new Error("A strict locator match policy cannot declare an index.");
    }
    return Object.freeze({ kind: "strict" });
  }
  if (data.kind === "index") {
    if (typeof data.index !== "number" || !Number.isInteger(data.index) || data.index < 0) {
      throw new Error("A locator match index must be a non-negative integer.");
    }
    return Object.freeze({ kind: "index", index: data.index });
  }
  throw new Error(`Unknown locator match policy: ${String(data.kind)}`);
}

function freezeScope(scope: Scope): Scope {
  switch (scope.kind) {
    case "desktop":
    case "application":
    case "activeWindow":
      return Object.freeze({ kind: scope.kind });
    case "window":
      return Object.freeze({ kind: "window", window: defineLocator(scope.window) });
    case "dialog":
      return Object.freeze({ kind: "dialog", dialog: defineLocator(scope.dialog) });
    case "element":
      return Object.freeze({ kind: "element", elementId: scope.elementId });
    default:
      throw new Error("Unknown locator scope.");
  }
}
