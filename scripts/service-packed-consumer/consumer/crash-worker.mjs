import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import { FileArtifactStore, FileRunStore, PersistentRunService } from "@surfaceloom/service";

import { crashSubmission, DurableCrashLifecycle } from "./crash-support.mjs";

const root = path.resolve(process.argv[2]);
mkdirSync(path.join(root, "workspace"), { recursive: true });
const executor = { id: "packed.crash",
  async execute(request) {
    appendFileSync(path.join(root, "execution.log"), `${request.runId}\n`);
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore", windowsHide: true,
    });
    writeFileSync(path.join(root, "live-child.json"), JSON.stringify({ pid: child.pid }));
    return new Promise(() => undefined);
  },
  async cancel(request) { return { runId: request.runId, disposition: "accepted" }; },
  async cleanup(request) { return { runId: request.runId, snapshotId: request.snapshot.snapshotId,
    status: "unconfirmed", tainted: true, attemptedAt: new Date().toISOString() }; },
};
const service = await PersistentRunService.create({
  runStore: await FileRunStore.open(path.join(root, "runs")),
  artifactStore: await FileArtifactStore.open(path.join(root, "artifacts")), executor,
  workspaceLifecycle: new DurableCrashLifecycle(root),
});
const started = await service.start(crashSubmission(root));
while ((await service.get(started.runId))?.status !== "running") {
  await new Promise(resolve => setTimeout(resolve, 10));
}
while (true) {
  try {
    const child = JSON.parse(await (await import("node:fs/promises")).readFile(
      path.join(root, "live-child.json"), "utf8"));
    writeFileSync(path.join(root, "worker-ready.json"), JSON.stringify({ runId: started.runId,
      childPid: child.pid }));
    break;
  } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
}
setInterval(() => undefined, 1_000);
