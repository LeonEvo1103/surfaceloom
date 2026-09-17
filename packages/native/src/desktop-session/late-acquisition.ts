import type { NativeClientOptions } from "../client/types.js";
import type { NativeSessionDescriptor } from "../contracts.js";
import { validateSessionDescriptor } from "../schema.js";

type LateEvent = Parameters<NonNullable<NativeClientOptions["onLateResponse"]>>[0];

/** Bounded mailbox for a late, receipt-bearing session.launch response. */
export class NativeLateAcquisitionMailbox {
  #session: NativeSessionDescriptor | null = null;
  readonly #waiters = new Set<(session: NativeSessionDescriptor) => void>();

  readonly accept = (event: LateEvent): void => {
    if (event.request.name !== "session.launch" || !event.response.ok
      || event.response.operation?.outcome !== "executed") return;
    let session: NativeSessionDescriptor;
    try { session = validateSessionDescriptor(event.response.result); }
    catch { return; }
    this.#session = session;
    for (const waiter of this.#waiters) waiter(session);
    this.#waiters.clear();
  };

  reconcile(timeoutMs: number, signal?: AbortSignal): Promise<NativeSessionDescriptor | null> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new Error("Reconciliation timeout must be a non-negative integer."));
    }
    if (this.#session !== null) return Promise.resolve(this.#session);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (session: NativeSessionDescriptor | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#waiters.delete(onSession);
        signal?.removeEventListener("abort", onAbort);
        resolve(session);
      };
      const onSession = (session: NativeSessionDescriptor): void => finish(session);
      const onAbort = (): void => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.#waiters.add(onSession);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
