import type {
  ResourceCleanupOutcome, ResourceCleanupResult, ResourceFailure, ResourceFailureCode,
  ResourceRegistration, ResourceScopeOptions,
} from "./resources-contracts.js";
import { cleanupResource } from "./resources-cleanup.js";
import { resourceErrorMessage, resourceTimeout, snapshotResource } from "./resources-validation.js";

export type {
  ResourceCleanupOutcome, ResourceCleanupReceipt, ResourceCleanupResult, ResourceFailure,
  ResourceFailureCode, ResourceRegistration, ResourceScopeOptions,
} from "./resources-contracts.js";

/**
 * SL-P1-052 ownership primitive. Only a successful registration transfers ownership.
 * Providers must register immediately after acquisition and truthfully confirm release.
 * This is not a JavaScript sandbox: synchronous blocking callbacks require isolation.
 */
export class ResourceScope {
  readonly #resources: ResourceRegistration[] = [];
  readonly #ids = new Set<string>();
  readonly #outcomes: ResourceCleanupOutcome[] = [];
  readonly #failures: ResourceFailure[] = [];
  readonly #timeoutMs: number;
  #state: ResourceCleanupResult["state"] = "open";
  #tainted = false;
  #closing: Promise<ResourceCleanupResult> | undefined;

  constructor(options: ResourceScopeOptions = {}) {
    this.#timeoutMs = resourceTimeout(options);
  }

  register(input: ResourceRegistration): void {
    this.assertOpen();
    let resource: ResourceRegistration;
    try { resource = snapshotResource(input); }
    catch (error) { this.rejectMutation("invalidRegistration", resourceErrorMessage(error)); }
    // Proxy descriptor traps may reenter close/register during snapshotting.
    this.assertOpen();
    if (this.#ids.has(resource.id)) {
      this.rejectMutation("duplicateResource", "Resource id is already registered.", resource.id);
    }
    this.#ids.add(resource.id);
    this.#resources.push(resource);
  }

  /** Record body/setup failure while open. Late calls throw and permanently taint the scope. */
  recordFailure(phase: string, error: unknown): void {
    this.assertOpen("failureRecording");
    const failure: ResourceFailure = Object.freeze({ phase: typeof phase === "string" && phase.trim()
      ? phase.slice(0, 128) : "execution", code: "executionFailed", message: resourceErrorMessage(error) });
    // Error descriptor traps can reenter close during message snapshotting.
    this.assertOpen("failureRecording");
    this.#failures.push(failure);
  }

  /** Concurrent/repeated calls share one promise; no cleanup callback is replayed. */
  close(): Promise<ResourceCleanupResult> {
    if (this.#closing !== undefined) return this.#closing;
    this.#state = "closing";
    // Defer callbacks until #closing exists, including for reentrant close calls.
    this.#closing = Promise.resolve().then(() => this.drain());
    return this.#closing;
  }

  /**
   * A frozen point-in-time result. Rejected late writes remain sticky failures here;
   * already-returned snapshots cannot change. Publish only after producer stop/barrier.
   */
  snapshot(): ResourceCleanupResult {
    const primaryFailure = this.#failures[0];
    return Object.freeze({ state: this.#state,
      status: primaryFailure !== undefined || this.#tainted ? "failed"
        : this.#state === "closed" ? "passed" : "pending",
      tainted: this.#tainted,
      outcomes: Object.freeze([...this.#outcomes]), failures: Object.freeze([...this.#failures]),
      ...(primaryFailure === undefined ? {} : { primaryFailure }) });
  }

  private assertOpen(phase: "registration" | "failureRecording" = "registration"): void {
    if (this.#state !== "open") {
      const operation = phase === "registration" ? "registrations" : "failure records";
      this.rejectMutation("scopeClosed", `Resource scope no longer accepts ${operation}.`, undefined, phase);
    }
  }

  private rejectMutation(code: ResourceFailureCode, message: string, resourceId?: string,
    phase = "registration"): never {
    this.#tainted = true;
    this.#failures.push(Object.freeze({ phase, code, message,
      ...(resourceId === undefined ? {} : { resourceId }) }));
    throw new Error(message);
  }

  private async drain(): Promise<ResourceCleanupResult> {
    for (const resource of [...this.#resources].reverse()) {
      const outcome: ResourceCleanupOutcome = resource.ownership === "borrowed"
        ? Object.freeze({ id: resource.id, ownership: "borrowed", status: "borrowed" })
        : await cleanupResource(resource, this.#timeoutMs);
      this.#outcomes.push(outcome);
      if (outcome.status === "failed" || outcome.status === "unconfirmed") {
        this.#tainted = true;
        this.#failures.push(outcome.failure);
      }
    }
    this.#state = "closed";
    return this.snapshot();
  }
}
