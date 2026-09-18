import type { NativeClientOptions } from "../client/types.js";
import type { NativeSessionDescriptor } from "../contracts.js";
import type { OperationReceipt } from "../contracts.js";
import { validateSessionDescriptor } from "../schema.js";

type LateEvent = Parameters<NonNullable<NativeClientOptions["onLateResponse"]>>[0];

/** One-controller mailbox for timed-out launch/attach responses. */
export class WindowsLateAcquisitionMailbox {
  readonly #sessions = new Map<"launch" | "attach", LateAcquisition>();
  readonly #waiters = new Map<"launch" | "attach", Set<(value: LateAcquisition) => void>>();

  readonly accept = (event: LateEvent): void => {
    const kind = event.request.name === "session.launch" ? "launch"
      : event.request.name === "session.attach" ? "attach" : null;
    if (kind === null || !event.response.ok || event.response.operation?.outcome !== "executed") return;
    let session: NativeSessionDescriptor;
    try { session = validateSessionDescriptor(event.response.result); } catch { return; }
    const acquisition = Object.freeze({ session, receipt: event.response.operation });
    this.#sessions.set(kind, acquisition);
    for (const waiter of this.#waiters.get(kind) ?? []) waiter(acquisition);
    this.#waiters.delete(kind);
  };

  wait(kind: "launch" | "attach", timeoutMs: number): Promise<LateAcquisition | null> {
    const current = this.#sessions.get(kind);
    if (current !== undefined) return Promise.resolve(current);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: LateAcquisition | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#waiters.get(kind)?.delete(onSession);
        resolve(value);
      };
      const onSession = (value: LateAcquisition): void => finish(value);
      const timer = setTimeout(() => finish(null), timeoutMs);
      const waiters = this.#waiters.get(kind) ?? new Set();
      waiters.add(onSession);
      this.#waiters.set(kind, waiters);
    });
  }
}

interface LateAcquisition {
  readonly session: NativeSessionDescriptor;
  readonly receipt: OperationReceipt;
}
