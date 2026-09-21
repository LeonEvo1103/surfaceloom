import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { validateTestDefinition } from "@surfaceloom/service";

export const crashTestId = "service-test:packed/crash";
export const crashRequestId = "packed-crash-request";

export function crashDefinition() {
  return validateTestDefinition({ schemaVersion: 1, testId: crashTestId,
    title: "Packed crash recovery", description: "Inject a service crash with a live child.",
    caseSpecs: [], coverage: { includes: ["service-crash"], exclusions: [] },
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    runtime: { executorId: "packed.crash", kind: "node" }, effect: "writesLocal",
    requirements: { platforms: ["darwin", "linux", "win32"], capabilities: ["node"], environment: [] },
    output: { resultFormat: "surfaceloom.run-result/v1", artifacts: [] } });
}

export function crashSubmission(root, requestId = crashRequestId) {
  const definition = crashDefinition();
  return { requestId, snapshot: { snapshotId: "snapshot:00000000-0000-4000-8000-000000000011",
    resolvedRevision: "packed-crash-revision" }, testId: definition.testId, parameters: {}, definition,
    workspace: { operationId: "operation:00000000-0000-4000-8000-000000000012",
      snapshotId: "snapshot:00000000-0000-4000-8000-000000000011",
      resolvedRevision: "packed-crash-revision", rootPath: path.join(root, "workspace"),
      runtimeMetadata: { provider: "packed-durable-fixture" }, autMetadata: { app: "neutral" } } };
}

export class DurableCrashLifecycle {
  constructor(root) { this.file = path.join(root, "workspace-lease.json"); mkdirSync(root, { recursive: true }); }
  acquireLease(snapshot, runId) {
    if (existsSync(this.file)) throw new Error("Crash-tainted workspace cannot be leased again.");
    const lease = { snapshotId: snapshot.snapshotId, runId, generation: 1,
      acquiredAt: new Date().toISOString() };
    writeFileSync(this.file, JSON.stringify({ state: "active", lease }));
    return lease;
  }
  completeLease(lease, cleanup) {
    writeFileSync(this.file, JSON.stringify({ state: cleanup.tainted ? "quarantined" : "safe",
      lease, cleanup }));
  }
  async release(snapshot) {
    if (existsSync(this.file)) {
      return { snapshotId: snapshot.snapshotId, status: "unconfirmed", tainted: true,
        attemptedAt: new Date().toISOString(), detail: "Durable crash lease is still active." };
    }
    return { snapshotId: snapshot.snapshotId, status: "confirmed", tainted: false,
      attemptedAt: new Date().toISOString() };
  }
}
