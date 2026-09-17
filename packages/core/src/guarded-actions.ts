import {
  actionabilityChecks,
  resolveActionabilityChecks,
  type ActionOptions,
  type ActionabilityCheck,
  type ElementActionKind,
} from "./actionability.js";
import {
  assertInvocationMaySubmit,
  awaitActionResolution,
  createInvocationContext,
  throwIfAborted,
  type ElementActionInvocationContext,
} from "./action-invocation.js";
import type { ElementReference } from "./driver.js";
import type { Locator } from "./locator.js";

export type ElementActionTarget = Locator | ElementReference;

export interface ActionabilityRequest {
  readonly action: ElementActionKind;
  readonly checks: readonly ActionabilityCheck[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type { ElementActionInvocationContext } from "./action-invocation.js";

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
  performResolvedAction(
    action: ResolvedElementAction,
    context?: ElementActionInvocationContext,
  ): Promise<void>;
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
    const { resolved, context } = await this.resolve("invoke", target, options);
    assertInvocationMaySubmit(context);
    await this.#backend.performResolvedAction(
      Object.freeze({ kind: "invoke", target: resolved }),
      context,
    );
  }

  public async setValue(
    target: ElementActionTarget,
    value: string,
    options: ActionOptions = {},
  ): Promise<void> {
    const { resolved, context } = await this.resolve("setValue", target, options);
    assertInvocationMaySubmit(context);
    await this.#backend.performResolvedAction(
      Object.freeze({ kind: "setValue", target: resolved, value }),
      context,
    );
  }

  public async typeText(
    target: ElementActionTarget,
    text: string,
    options: ActionOptions = {},
  ): Promise<void> {
    const { resolved, context } = await this.resolve("typeText", target, options);
    assertInvocationMaySubmit(context);
    await this.#backend.performResolvedAction(
      Object.freeze({ kind: "typeText", target: resolved, text }),
      context,
    );
  }

  private async resolve(
    action: ElementActionKind,
    target: ElementActionTarget,
    options: ActionOptions,
  ): Promise<{ readonly resolved: ElementReference; readonly context: ElementActionInvocationContext }> {
    const request = freezeRequest(action, options);
    const startedAt = monotonicNow();
    const context = createInvocationContext(startedAt, request.timeoutMs, request.signal);
    throwIfAborted(context.signal);
    const unsupported = request.checks.filter(
      (check) => !this.#supportedChecks.has(check),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `The action backend cannot enforce required checks: ${unsupported.join(", ")}.`,
      );
    }
    const pending = this.#backend.resolveActionability(target, request);
    const resolved = await awaitActionResolution(
      pending,
      request.timeoutMs,
      startedAt,
      request.signal,
    );
    return Object.freeze({ resolved: validateResolvedElement(resolved), context });
  }
}

function freezeRequest(
  action: ElementActionKind,
  options: ActionOptions,
): ActionabilityRequest {
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  const snapshot = Object.freeze({
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
    ...(options.additionalChecks === undefined ? {} : { additionalChecks: options.additionalChecks }),
    ...(options.force === undefined ? {} : { force: options.force }),
  });
  return Object.freeze({
    action,
    checks: resolveActionabilityChecks(action, snapshot),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  });
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
