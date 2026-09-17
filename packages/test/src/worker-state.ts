import type {
  WorkerFailure, WorkerFailureCode, WorkerSettlementSummary, WorkerStopSnapshot, WorkerStopState,
} from "./worker-contracts.js";
import { workerErrorMessage, workerExitCode, workerSettlement } from "./worker-validation.js";

/** Internal recorder. Public adapters exclusively own receipt and event provenance. */
export class WorkerState {
  readonly #isolation: WorkerStopSnapshot["isolation"];
  readonly #failures: WorkerFailure[] = [];
  #state: WorkerStopState = "running";
  #tainted = false;
  #requested = false;
  #effects: WorkerStopSnapshot["externalEffects"];
  #settlement: WorkerSettlementSummary | null = null;
  #receiptInput: unknown;
  #exitCode: number | null = null;

  constructor(isolation: WorkerStopSnapshot["isolation"], effects: "none" | "possible") {
    this.#isolation = isolation;
    this.#effects = effects === "none" ? "notApplicable" : "unverified";
  }

  snapshot(): WorkerStopSnapshot {
    return Object.freeze({ isolation: this.#isolation, state: this.#state, tainted: this.#tainted,
      cancellationRequested: this.#requested, externalEffects: this.#effects,
      settlement: this.#settlement, exitCode: this.#exitCode, failures: Object.freeze([...this.#failures]) });
  }

  requestStop(): void {
    if (this.#requested) return;
    this.#requested = true;
    if (this.#state === "running") this.#state = "stopRequested";
    if (this.#effects === "unverified") this.markExternalEffectsUnknown();
  }

  markExternalEffectsUnknown(): WorkerStopSnapshot {
    if (this.#effects !== "unknown") {
      this.#effects = "unknown";
      this.failure("externalEffectsUnknown", "Execution stop does not establish the outcome of external effects.");
    }
    return this.snapshot();
  }

  acceptSettlement(input: unknown, acknowledged: boolean): boolean {
    if (this.#settlement !== null && input === this.#receiptInput) {
      if (acknowledged === this.#settlement.cancellationAcknowledged) return false;
      return this.reject("conflictingReceipt", "Cancellation acknowledgment changed after settlement.");
    }
    let receipt: WorkerSettlementSummary;
    try {
      if (this.#isolation !== "inProcess") throw new Error("Task settlement is not a Worker exit receipt.");
      receipt = workerSettlement(input, acknowledged);
    } catch (error) { return this.reject("invalidReceipt", workerErrorMessage(error)); }
    if (this.#settlement !== null) {
      if (JSON.stringify(receipt) === JSON.stringify(this.#settlement)) return false;
      return this.reject("conflictingReceipt", "A different task settlement receipt was already accepted.");
    }
    this.#settlement = receipt;
    this.#receiptInput = input;
    if (receipt.cancellationRequested) {
      if (receipt.status === "notStarted") this.#requested = true;
      else this.requestStop();
    }
    this.#state = receipt.status === "notStarted" ? "notStarted"
      : receipt.cancellationAcknowledged ? "cooperativeStopped" : "settled";
    if (receipt.errorMessage !== null) this.failure("taskRejected", receipt.errorMessage, false);
    return true;
  }

  observeExit(input: unknown): void {
    let code: number;
    try {
      if (this.#isolation !== "nodeWorker") throw new Error("In-process tasks have no worker termination boundary.");
      code = workerExitCode(input);
    } catch (error) { return this.reject("invalidReceipt", workerErrorMessage(error)); }
    if (this.#exitCode !== null) {
      if (this.#exitCode !== code) this.reject("conflictingReceipt", "Conflicting Worker exit receipts.");
      return;
    }
    this.#exitCode = code;
    this.#state = "workerExited";
  }

  confirmTermination(input: unknown): void {
    let code: number;
    try { code = workerExitCode(input); }
    catch (error) { return this.reject("invalidReceipt", workerErrorMessage(error)); }
    if (this.#isolation !== "nodeWorker" || !this.#requested || this.#exitCode !== code) {
      this.reject("invalidReceipt", "Worker termination requires a matching observed exit and stop request.");
    }
    if (this.#state === "workerTerminated") return;
    this.#state = "workerTerminated";
    this.failure("forcedTermination", "Worker terminated; interrupted resource and effect state must not be reused.");
  }

  unconfirmed(code: "stopUnconfirmed" | "terminationUnconfirmed", message: string): void {
    if (this.#settlement === null && this.#exitCode === null) this.#state = "unconfirmed";
    this.failure(code, message);
  }

  failure(code: WorkerFailureCode, message: string, tainted = true): void {
    if (tainted) this.#tainted = true;
    this.#failures.push(Object.freeze({ code, message: message.slice(0, 2048) }));
  }

  private reject(code: "invalidReceipt" | "conflictingReceipt", message: string): never {
    this.failure(code, message);
    throw new Error(message);
  }
}
