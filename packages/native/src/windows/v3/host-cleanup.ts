import type { WindowsNativeController } from "../controller.js";
import type { WindowsHostCleanupReceipt, WindowsSurfaceSetupContext } from "./contracts.js";

export function registerWindowsHostCleanup(context: WindowsSurfaceSetupContext, surfaceId: string,
  hostId: string, controller: WindowsNativeController): void {
  let cleanup: Promise<WindowsHostCleanupReceipt> | null = null;
  context.registerResource({ id: `native.${surfaceId}.host.${hostId}`, ownership: "owned", cleanup: () => {
    cleanup ??= close(controller);
    return cleanup;
  } });
}

async function close(controller: WindowsNativeController): Promise<WindowsHostCleanupReceipt> {
  try {
    const receipt = await controller.close();
    return receipt.status === "exited" || receipt.status === "notSpawned"
      ? Object.freeze({ status: "released" as const })
      : Object.freeze({ status: "unconfirmed" as const, reason: receipt.reason });
  } catch (error) {
    return Object.freeze({ status: "unconfirmed" as const,
      reason: `Windows host cleanup failed: ${error instanceof Error ? error.message : "unknown error"}` });
  }
}
