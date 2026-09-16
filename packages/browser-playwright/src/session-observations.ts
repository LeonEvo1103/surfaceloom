import type { BrowserObservation, BrowserObservationBatch, BrowserObservationHandle, BrowserObservationOptions } from "./contracts.js";
import type { PlaywrightPageLike } from "./playwright-shapes.js";
import { ObservationBuffer, observationLimit } from "./observation-buffer.js";
import { observationBindings, type ObservationBinding } from "./observation-normalization.js";

interface ObservationSubscription {
  readonly buffer: ObservationBuffer;
  readonly handle: BrowserObservationHandle;
}

export class SessionObservations {
  private readonly subscriptions = new Set<ObservationSubscription>();
  /** Page listeners are bound once for the whole session and fanned out to subscribers. */
  private bindings: readonly ObservationBinding[] | undefined;
  /** Stable per-session identity for Playwright Request instances. */
  private readonly requestIds = new WeakMap<object, number>();
  private nextRequestId = 1;

  public constructor(private readonly page: PlaywrightPageLike) {}

  public observe(options: BrowserObservationOptions = {}): BrowserObservationHandle {
    const buffer = new ObservationBuffer(observationLimit(options.limit));

    let snapshot: BrowserObservationBatch | undefined;
    const handle: BrowserObservationHandle = {
      stop: (): BrowserObservationBatch => {
        const sealed = snapshot;
        if (sealed !== undefined) return sealed;
        this.subscriptions.delete(subscription);
        this.detachWhenUnobserved();
        snapshot = Object.freeze({
          observations: buffer.drain(),
          dropped: buffer.dropped,
        });
        return snapshot;
      },
    };
    const subscription: ObservationSubscription = { buffer, handle };
    this.subscriptions.add(subscription);
    try {
      this.attachObservers();
    } catch (error) {
      // observe() is about to throw, so the caller never receives this handle and
      // nothing can ever call stop() for it. Left in the set the subscription would
      // keep detachWhenUnobserved() from ever firing again and keep filling a buffer
      // no one can drain, so it unwinds here instead.
      this.subscriptions.delete(subscription);
      this.detachWhenUnobserved();
      throw error;
    }
    return handle;
  }

  public stopAll(): void {
    for (const subscription of [...this.subscriptions]) subscription.handle.stop();
  }

  /**
   * Binds the page listeners once. Every `observe()` call used to register its own six
   * listeners, so repeated subscriptions piled handlers onto the same page.
   */
  private attachObservers(): void {
    if (this.bindings !== undefined) return;
    const bindings = observationBindings(
      (observation: BrowserObservation): void => {
        for (const subscription of this.subscriptions) subscription.buffer.push(observation);
      },
      (payload: unknown): number | undefined => this.identifyRequest(payload),
    );
    const attached: ObservationBinding[] = [];
    try {
      for (const entry of bindings) {
        this.page.on(entry[0], entry[1]);
        attached.push(entry);
      }
    } catch (error) {
      // A half-bound page is worse than an unbound one: `this.bindings` stays
      // undefined, so the handlers already registered are unreachable for detach
      // and the next attach would add a second copy of each one, doubling every
      // observation. Undo the partial registration before the failure propagates.
      for (const [event, handler] of attached) {
        try {
          this.page.off(event, handler);
        } catch {
          // Rollback must never mask the registration failure being reported.
        }
      }
      throw error;
    }
    this.bindings = bindings;
  }

  private detachWhenUnobserved(): void {
    const bindings = this.bindings;
    if (bindings === undefined || this.subscriptions.size > 0) return;
    this.bindings = undefined;
    for (const [event, handler] of bindings) {
      try {
        this.page.off(event, handler);
      } catch {
        // Detaching must never mask the caller's own result.
      }
    }
  }

  /**
   * Playwright dispatches one Request instance to `request`, `requestfinished` and
   * `requestfailed`, and `response.request()` returns that same instance, all inside this
   * process. A WeakMap keyed on the instance therefore pairs lifecycle events exactly,
   * without retaining the object after Playwright drops it.
   */
  private identifyRequest(payload: unknown): number | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;
    const known = this.requestIds.get(payload);
    if (known !== undefined) return known;
    const assigned = this.nextRequestId;
    this.nextRequestId += 1;
    this.requestIds.set(payload, assigned);
    return assigned;
  }

}
