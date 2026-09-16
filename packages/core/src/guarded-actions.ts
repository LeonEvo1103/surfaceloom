import {
  actionabilityChecks,
  resolveActionabilityChecks,
  type ActionOptions,
  type ActionabilityCheck,
  type ElementActionKind,
} from "./actionability.js";
import type { ElementReference } from "./driver.js";
import type { Locator } from "./locator.js";

export type ElementActionTarget = Locator | ElementReference;

export interface ActionabilityRequest {
  readonly action: ElementActionKind;
  readonly checks: readonly ActionabilityCheck[];
  readonly timeoutMs?: number;
}

export type ResolvedElementAction =
  | { readonly kind: "invoke"; readonly target: ElementReference }
  | {
      readonly kind: "setValue";
      readonly target: ElementReference;
      readonly value: string;
    }
  | {
      readonly kind: "typeText";
      readonly target: ElementReference;
      readonly text: string;
    };

/**
 * Native boundary used by the guarded facade. Resolution may retry while the
 * action itself is submitted exactly once after all requested checks pass.
 */
export interface ElementActionBackend {
  /** Must describe every check this backend can actually enforce. */
  readonly supportedActionabilityChecks: readonly ActionabilityCheck[];
  /** Must reject stale references and references owned by another session. */
  resolveActionability(
    target: ElementActionTarget,
    request: ActionabilityRequest,
  ): Promise<ElementReference>;
  performResolvedAction(action: ResolvedElementAction): Promise<void>;
}

export interface ElementActions {
  invoke(target: ElementActionTarget, options?: ActionOptions): Promise<void>;
  setValue(
    target: ElementActionTarget,
    value: string,
    options?: ActionOptions,
  ): Promise<void>;
  typeText(
    target: ElementActionTarget,
    text: string,
    options?: ActionOptions,
  ): Promise<void>;
}

/** Public action path for sessions and semantic components. */
export class GuardedElementActions implements ElementActions {
  readonly #backend: ElementActionBackend;
  readonly #supportedChecks: ReadonlySet<ActionabilityCheck>;

  private constructor(backend: ElementActionBackend) {
    this.#backend = backend;
    this.#supportedChecks = validateSupportedChecks(
      backend.supportedActionabilityChecks,
    );
  }

  /** The private constructor prevents adapters from substituting an unguarded facade. */
  public static fromBackend(backend: ElementActionBackend): GuardedElementActions {
    return new GuardedElementActions(backend);
  }

  public async invoke(
    target: ElementActionTarget,
    options: ActionOptions = {},
  ): Promise<void> {
    const resolved = await this.resolve("invoke", target, options);
    await this.#backend.performResolvedAction(
      Object.freeze({ kind: "invoke", target: resolved }),
    );
  }

  public async setValue(
    target: ElementActionTarget,
    value: string,
    options: ActionOptions = {},
  ): Promise<void> {
    const resolved = await this.resolve("setValue", target, options);
    await this.#backend.performResolvedAction(
      Object.freeze({ kind: "setValue", target: resolved, value }),
    );
  }

  public async typeText(
    target: ElementActionTarget,
    text: string,
    options: ActionOptions = {},
  ): Promise<void> {
    const resolved = await this.resolve("typeText", target, options);
    await this.#backend.performResolvedAction(
      Object.freeze({ kind: "typeText", target: resolved, text }),
    );
  }

  private async resolve(
    action: ElementActionKind,
    target: ElementActionTarget,
    options: ActionOptions,
  ): Promise<ElementReference> {
    const request = freezeRequest(action, options);
    const unsupported = request.checks.filter(
      (check) => !this.#supportedChecks.has(check),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `The action backend cannot enforce required checks: ${unsupported.join(", ")}.`,
      );
    }
    const startedAt = monotonicNow();
    const pending = this.#backend.resolveActionability(target, request);
    const resolved = await enforceResolutionTimeout(
      pending,
      request.timeoutMs,
      startedAt,
    );
    return validateResolvedElement(resolved);
  }
}

function freezeRequest(
  action: ElementActionKind,
  options: ActionOptions,
): ActionabilityRequest {
  const timeout =
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  return Object.freeze({
    action,
    checks: resolveActionabilityChecks(action, options),
    ...timeout,
  });
}

function enforceResolutionTimeout<T>(
  pending: Promise<T>,
  timeoutMs: number | undefined,
  startedAt: number,
): Promise<T> {
  if (timeoutMs === undefined) return pending;
  const remaining = timeoutMs - (monotonicNow() - startedAt);
  if (remaining <= 0) {
    void pending.catch(() => undefined);
    return Promise.reject(resolutionTimeoutError(timeoutMs));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(resolutionTimeoutError(timeoutMs));
    }, remaining);
    pending.then(
      (value) => {
        clearTimeout(timer);
        if (monotonicNow() - startedAt >= timeoutMs) {
          reject(resolutionTimeoutError(timeoutMs));
        } else {
          resolve(value);
        }
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resolutionTimeoutError(timeoutMs: number): Error {
  return new Error(`Actionability resolution timed out after ${timeoutMs}ms.`);
}

function monotonicNow(): number {
  return globalThis.performance.now();
}

function validateSupportedChecks(
  checks: readonly ActionabilityCheck[],
): ReadonlySet<ActionabilityCheck> {
  const supported = new Set<ActionabilityCheck>();
  for (const check of checks) {
    if (!actionabilityChecks.includes(check)) {
      throw new Error(`Unknown backend actionability check: ${String(check)}`);
    }
    if (supported.has(check)) {
      throw new Error(`Duplicate backend actionability check: ${check}`);
    }
    supported.add(check);
  }
  return supported;
}

function validateResolvedElement(value: ElementReference): ElementReference {
  const candidate = value as unknown as {
    readonly id?: unknown;
    readonly locator?: { readonly key?: unknown };
  };
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.id !== "string" ||
    candidate.id.trim().length === 0 ||
    typeof candidate.locator !== "object" ||
    candidate.locator === null ||
    typeof candidate.locator.key !== "string" ||
    candidate.locator.key.trim().length === 0
  ) {
    throw new Error("The action backend returned an invalid resolved element.");
  }
  return value;
}
