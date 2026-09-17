import type { ResourceCleanupReceipt, ResourceRegistration, ResourceScopeOptions } from "./resources-contracts.js";

/** Read only own data fields: an accessor must not execute during boundary validation. */
function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object") throw new Error("Expected a plain resource record.");
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Expected a plain resource record.");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Error("Unexpected resource record field.");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new Error("Resource fields must be data properties.");
    result[key] = descriptor.value;
  }
  return result;
}

export function resourceTimeout(input: ResourceScopeOptions): number {
  const configured = fields(input, ["cleanupTimeoutMs", "cleanupDeadlineAt"]).cleanupTimeoutMs;
  const value = configured === undefined ? 5000 : configured;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("cleanupTimeoutMs must be finite and between 1 and 2147483647.");
  }
  return value;
}

export function resourceCleanupDeadline(input: ResourceScopeOptions): number {
  const configured = fields(input, ["cleanupTimeoutMs", "cleanupDeadlineAt"]).cleanupDeadlineAt;
  const value = configured === undefined ? Number.MAX_SAFE_INTEGER : configured;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("cleanupDeadlineAt must be a finite monotonic timestamp.");
  }
  return value;
}

export function snapshotResource(input: ResourceRegistration): ResourceRegistration {
  const record = fields(input, ["id", "ownership", "cleanup"]);
  const { id, ownership, cleanup } = record;
  if (typeof id !== "string" || id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(id)) {
    throw new Error("A resource requires a stable nonempty machine id.");
  }
  if (ownership === "borrowed" && !("cleanup" in record)) return Object.freeze({ id, ownership });
  if (ownership !== "owned" || typeof cleanup !== "function") {
    throw new Error("Owned resources need cleanup; borrowed resources cannot supply cleanup.");
  }
  return Object.freeze({ id, ownership, cleanup: cleanup as Extract<ResourceRegistration, { ownership: "owned" }>["cleanup"] });
}

export function snapshotReceipt(input: unknown): ResourceCleanupReceipt {
  const { status, reason } = fields(input, ["status", "reason"]);
  if (status === "released" && reason === undefined) return Object.freeze({ status });
  if (status === "unconfirmed" && typeof reason === "string" && reason.trim().length > 0) {
    return Object.freeze({ status, reason: reason.slice(0, 2048) });
  }
  throw new Error("Cleanup must return an explicit released or unconfirmed receipt.");
}

/** No coercion, getters, or arbitrary Error inspection while retaining a failure. */
export function resourceErrorMessage(error: unknown, seen = new Set<unknown>()): string {
  if (typeof error === "string" && error.trim()) return error.slice(0, 2048);
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      if (seen.size < 16 && !seen.has(error) && error instanceof AggregateError) {
        seen.add(error);
        const errors = Object.getOwnPropertyDescriptor(error, "errors");
        if (errors !== undefined && "value" in errors && Array.isArray(errors.value)) {
          const first = Object.getOwnPropertyDescriptor(errors.value, "0");
          if (first !== undefined && "value" in first) return resourceErrorMessage(first.value, seen);
        }
      }
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
          && descriptor.value.trim()) return descriptor.value.slice(0, 2048);
    } catch { /* A hostile error must never stop subsequent cleanup. */ }
  }
  return "Failure details were unavailable or unsafe to inspect.";
}
