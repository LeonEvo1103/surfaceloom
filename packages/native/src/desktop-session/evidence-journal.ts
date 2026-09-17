import type { NativeInvocationResult } from "../client/index.js";
import type {
  DesktopSessionEvidence,
  DesktopSessionEvidenceSink,
  NativeSessionIdentity,
} from "./contracts.js";

/** In-memory evidence is bounded; durable sinks can implement the same contract. */
export class BoundedDesktopSessionJournal implements DesktopSessionEvidenceSink {
  readonly #capacity: number;
  readonly #items: DesktopSessionEvidence[] = [];
  #sequence = 0;

  constructor(capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Desktop session journal capacity must be a positive integer.");
    }
    this.#capacity = capacity;
  }

  append(evidence: Omit<DesktopSessionEvidence, "sequence">): void {
    const item = Object.freeze({ ...evidence, identity: Object.freeze({ ...evidence.identity }),
      operation: evidence.operation === null ? null : Object.freeze({ ...evidence.operation }),
      sequence: ++this.#sequence });
    this.#items.push(item);
    if (this.#items.length > this.#capacity) this.#items.shift();
  }

  snapshot(): readonly DesktopSessionEvidence[] {
    return Object.freeze([...this.#items]);
  }
}

/** Records only protocol evidence; a fulfilled legacy Promise<void> records nothing. */
export async function retainOperationEvidence<T>(
  pending: Promise<NativeInvocationResult<T>>,
  method: string,
  identity: NativeSessionIdentity,
  sink: DesktopSessionEvidenceSink,
): Promise<NativeInvocationResult<T>> {
  const result = await pending;
  sink.append(Object.freeze({ method, identity, operation: result.operation, status: "success" }));
  return result;
}

export async function invokeLegacyCompatible(
  operation: () => Promise<void>,
): Promise<void> {
  await operation();
}
