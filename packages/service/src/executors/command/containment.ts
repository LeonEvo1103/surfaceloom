import { types } from "node:util";

import { readSafeRecordEnvelope } from "../../safe-data.js";
import { exactKeys } from "../../validation.js";
import type {
  CommandSpawn, CommandSpawnOptions, ProcessIdentityReceipt, ProcessTreeController,
  ProcessTreeHandle, ProcessTreeLaunch, ProcessTreeReceipt,
} from "./contracts.js";

const unavailable: ProcessTreeHandle = Object.freeze({
  cleanup: async (): Promise<ProcessTreeReceipt> => Object.freeze({
    status: "unconfirmed",
    detail: "No cross-platform owned process-tree containment adapter was configured.",
  }),
});

export function launchOwnedProcess(
  controller: ProcessTreeController | undefined,
  spawn: CommandSpawn,
  executable: string,
  argv: readonly string[],
  options: CommandSpawnOptions,
  identity: ProcessIdentityReceipt,
  register: (child: ProcessTreeLaunch["child"]) => void,
): ProcessTreeLaunch {
  let spawned: ProcessTreeLaunch["child"] | undefined;
  let spawnCalled = false;
  let registrationCompleted = false;
  let launchActive = true;
  const trackedSpawn: CommandSpawn = (file, args, spawnOptions) => {
    if (!launchActive) {
      throw new Error("Process-tree spawn capability expired after the synchronous launch call.");
    }
    if (spawnCalled) throw new Error("Process-tree controller attempted more than one spawn.");
    spawnCalled = true;
    const child = spawn(file, args, spawnOptions);
    spawned = child;
    register(child);
    registrationCompleted = true;
    return child;
  };
  if (controller === undefined) {
    return Object.freeze({ child: trackedSpawn(executable, argv, options), handle: unavailable });
  }
  let launched: unknown;
  try {
    launched = controller.launch(trackedSpawn, executable, argv, options, identity);
  } finally {
    launchActive = false;
  }
  if (typeof launched !== "object" || launched === null || types.isProxy(launched)) {
    throw new TypeError("Process-tree launch must return a non-Proxy object.");
  }
  if (types.isPromise(launched)) {
    Promise.prototype.then.call(launched, undefined, () => undefined);
    throw new TypeError("Process-tree launch must synchronously return a launch receipt.");
  }
  if (hasThenableShape(launched)) {
    throw new TypeError("Process-tree launch must synchronously return a launch receipt.");
  }
  const child = dataProperty(launched, "child");
  const handle = dataProperty(launched, "handle");
  if (!registrationCompleted || spawned === undefined) {
    throw new TypeError("Process-tree controller must create the child with the supplied spawn function.");
  }
  if (child !== spawned) {
    throw new TypeError("Process-tree launch child must be the child returned by the supplied spawn function.");
  }
  return Object.freeze({ child: child as ProcessTreeLaunch["child"],
    handle: snapshotHandle(handle as ProcessTreeHandle) });
}

function hasThenableShape(input: object): boolean {
  let current: object | null = input;
  while (current !== null) {
    if (types.isProxy(current)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(current, "then");
    if (descriptor !== undefined) {
      return !("value" in descriptor) || typeof descriptor.value === "function";
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function dataProperty(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`Process-tree launch ${key} must be an own data property.`);
  }
  return descriptor.value;
}

export async function cleanupProcessTree(
  handle: ProcessTreeHandle,
  timeoutMs: number,
): Promise<ProcessTreeReceipt> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = Promise.resolve()
    .then(() => handle.cleanup(controller.signal))
    .then(validateReceipt)
    .catch((error: unknown): ProcessTreeReceipt => unconfirmedReceipt(error));
  const timeout = new Promise<ProcessTreeReceipt>((resolve) => {
    timer = setTimeout(() => {
      controller.abort("Process-tree cleanup deadline elapsed.");
      resolve(Object.freeze({ status: "unconfirmed",
        detail: "Process-tree cleanup did not settle before its deadline." }));
    }, timeoutMs);
  });
  try {
    const receipt = await Promise.race([cleanup, timeout]);
    return receipt;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unconfirmedReceipt(error: unknown): ProcessTreeReceipt {
  return Object.freeze({ status: "unconfirmed",
    detail: error instanceof Error ? error.message : "Process-tree cleanup failed." });
}

function snapshotHandle(input: ProcessTreeHandle): ProcessTreeHandle {
  if (typeof input !== "object" || input === null || types.isProxy(input)) {
    throw new TypeError("Process-tree handle must be a non-Proxy object.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, "cleanup");
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function" ||
    types.isProxy(descriptor.value)) {
    throw new TypeError("Process-tree cleanup must be an own non-Proxy data function.");
  }
  const cleanup = descriptor.value as ProcessTreeHandle["cleanup"];
  return Object.freeze({ cleanup: (signal: AbortSignal) => cleanup(signal) });
}

function validateReceipt(input: ProcessTreeReceipt): ProcessTreeReceipt {
  const value = readSafeRecordEnvelope(input, "ProcessTreeReceipt");
  if (value.status === "confirmed" || value.status === "not-required") {
    exactKeys(value, "ProcessTreeReceipt", ["status"]);
    return Object.freeze({ status: value.status });
  }
  if (value.status === "unconfirmed") {
    exactKeys(value, "ProcessTreeReceipt", ["status", "detail"]);
    if (typeof value.detail !== "string" || value.detail.length === 0) {
      throw new TypeError("Unconfirmed process-tree receipt requires detail.");
    }
    return Object.freeze({ status: "unconfirmed", detail: value.detail });
  }
  throw new TypeError("Process-tree receipt has an unsupported status.");
}
