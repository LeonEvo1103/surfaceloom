import { assertAbortSignal } from "./action-invocation.js";

export const actionabilityChecks = [
  "attached",
  "unique",
  "visible",
  "stable",
  "enabled",
  "editable",
  "focusable",
  "receivesInput",
] as const;

export type ActionabilityCheck = (typeof actionabilityChecks)[number];

export const elementActionKinds = ["invoke", "setValue", "typeText"] as const;

export type ElementActionKind = (typeof elementActionKinds)[number];

/**
 * Options for one element action. Side-effecting actions are never replayed by
 * Core; retries belong to locator resolution and pre-action checks only.
 */
export interface ActionOptions {
  /** Deadline for locating the target and completing pre-action checks. */
  readonly timeoutMs?: number;
  /** Cancels only this invocation; it is never retained as session state. */
  readonly signal?: AbortSignal;
  /** Adds backend-supported checks without weakening the action defaults. */
  readonly additionalChecks?: readonly ActionabilityCheck[];
  /** Keeps essential attached/unique checks while bypassing optional checks. */
  readonly force?: boolean;
}

const essentialChecks = ["attached", "unique"] as const;

const defaults: Readonly<Record<ElementActionKind, readonly ActionabilityCheck[]>> = {
  invoke: [...essentialChecks, "visible", "enabled"],
  setValue: [...essentialChecks, "visible", "enabled", "editable"],
  typeText: [
    ...essentialChecks,
    "visible",
    "enabled",
    "editable",
    "focusable",
  ],
};

export function resolveActionabilityChecks(
  action: ElementActionKind,
  options: ActionOptions = {},
): readonly ActionabilityCheck[] {
  assertTimeout(options.timeoutMs);
  if (options.signal !== undefined) assertAbortSignal(options.signal);
  if (options.force !== undefined && typeof options.force !== "boolean") {
    throw new Error("Action force must be a boolean.");
  }
  if (
    options.additionalChecks !== undefined &&
    !Array.isArray(options.additionalChecks)
  ) {
    throw new Error("Action additionalChecks must be an array.");
  }
  for (const check of options.additionalChecks ?? []) {
    if (!actionabilityChecks.includes(check)) {
      throw new Error(`Unknown actionability check: ${String(check)}`);
    }
  }

  const requested = options.force === true
    ? [...essentialChecks, ...(options.additionalChecks ?? [])]
    : [...defaults[action], ...(options.additionalChecks ?? [])];
  const result = [...essentialChecks, ...requested];
  return Object.freeze([...new Set(result)]);
}

function assertTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new Error("An action timeout must be a non-negative finite number.");
  }
}
