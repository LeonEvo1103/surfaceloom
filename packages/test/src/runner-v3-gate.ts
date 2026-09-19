import type { RunnerCaseExecutionResult } from "./execute.js";
import type { ExecutionGuiGate } from "./execution-gate.js";

/** Runner-owned final barrier. It is intentionally outside ResourceScope cleanup ordering. */
export class RunnerV3GateBarrier {
  readonly #gate: ExecutionGuiGate | undefined;
  #guiAcquisitionStarted = false;
  #guiAcquisitionUnknown = false;
  #cleanupConfirmed = false;
  #finalized = false;

  constructor(gate: ExecutionGuiGate | undefined) { this.#gate = gate; }

  markGuiAcquisitionStarted(): void {
    this.#guiAcquisitionStarted = true;
    this.#guiAcquisitionUnknown = true;
  }

  markGuiAcquisitionCompleted(): void { this.#guiAcquisitionUnknown = false; }

  observeExecution(result: RunnerCaseExecutionResult): void {
    this.#cleanupConfirmed = !this.#guiAcquisitionUnknown && result.publicationReady
      && result.cleanup.state === "closed"
      && result.cleanup.status === "passed"
      && !result.cleanup.tainted
      && (result.worker.state === "settled" || result.worker.state === "cooperativeStopped");
  }

  async finalize(): Promise<void> {
    if (this.#finalized || this.#gate === undefined) return;
    this.#finalized = true;
    if (!this.#guiAcquisitionStarted || this.#cleanupConfirmed) {
      const receipt = await this.#gate.release();
      if (receipt.status !== "released") {
        throw new Error("GUI execution gate release was not confirmed.");
      }
      return;
    }
    await this.#gate.quarantine(
      "GUI acquisition started without a settled, closed, untainted, passed cleanup result.",
    );
  }
}
