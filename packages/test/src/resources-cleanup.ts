import { types } from "node:util";
import type { ResourceCleanupOutcome, ResourceFailureCode, ResourceRegistration } from "./resources-contracts.js";
import { resourceErrorMessage, snapshotReceipt } from "./resources-validation.js";

type OwnedResource = Extract<ResourceRegistration, { ownership: "owned" }>;
const subscribe = Promise.prototype.then;

/** SL-P1-052: bounded receipt waiting never asserts that a pending callback stopped. */
export function cleanupResource(resource: OwnedResource, timeoutMs: number): Promise<ResourceCleanupOutcome> {
  return new Promise((resolve) => {
    let finished = false;
    const started = performance.now();
    const finish = (outcome: ResourceCleanupOutcome): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(Object.freeze(outcome));
    };
    const fail = (status: "failed" | "unconfirmed", code: ResourceFailureCode, message: string): void => {
      finish({ id: resource.id, ownership: "owned", status,
        failure: Object.freeze({ phase: "cleanup", code, message, resourceId: resource.id }) });
    };
    const timedOut = (): void => fail("unconfirmed", "cleanupTimedOut",
      "Cleanup receipt wait expired; release and callback termination are unconfirmed.");
    const timer = setTimeout(timedOut, timeoutMs);
    const fulfilled = (value: unknown): void => {
      if (finished) return;
      if (performance.now() - started >= timeoutMs) { timedOut(); return; }
      try {
        const receipt = snapshotReceipt(value);
        if (performance.now() - started >= timeoutMs) { timedOut(); return; }
        if (receipt.status === "released") finish({ id: resource.id, ownership: "owned", status: "released" });
        else fail("unconfirmed", "cleanupUnconfirmed", receipt.reason);
      } catch (error) { fail("unconfirmed", "invalidCleanupReceipt", resourceErrorMessage(error)); }
    };
    const rejected = (error: unknown): void => {
      if (finished) return;
      fail("failed", "cleanupFailed", resourceErrorMessage(error));
    };
    try {
      const value: unknown = resource.cleanup();
      if (!types.isPromise(value)) { fulfilled(value); return; }
      // Native promises are observed using the intrinsic method, not an overridable
      // then getter. Arbitrary thenables are invalid receipts and never assimilated.
      // Constructors/species that throw are caught and cannot produce a green result.
      subscribe.call(value, fulfilled, rejected);
    } catch (error) { rejected(error); }
  });
}
