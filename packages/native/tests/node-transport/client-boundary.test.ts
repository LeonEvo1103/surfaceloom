import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  NativeClient, NativeClientError, NativeTransportWriteError, jsonResultCodec,
  type NativeClientRuntime, type NativeClientTransport, type NativeTransportHandlers,
  type NativeWriteReceipt,
} from "../../src/client/index.js";
import { NodeChildProcessTransport } from "../../src/node-transport/index.js";

const fixture = fileURLToPath(new URL("../fixtures/node-transport-host.mjs", import.meta.url));
const loadedProcessDeadlineMs = 30_000;
// Real timers keep setup and requests bounded. A fixed accounting clock keeps
// unrelated scheduler stalls out of these admission/crash classification tests.
const loadStableRuntime: NativeClientRuntime = Object.freeze({
  now: () => 0,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function make(maxOutstandingWriteBytes: number): NodeChildProcessTransport {
  return new NodeChildProcessTransport({ executable: process.execPath, cwd: process.cwd(),
    argv: [fixture, "protocol-crash"], maxOutstandingWriteBytes, closeGraceMs: 25,
    startupTimeoutMs: loadedProcessDeadlineMs, writeTimeoutMs: loadedProcessDeadlineMs });
}

class TightenableAdmissionTransport implements NativeClientTransport {
  readonly #delegate: NodeChildProcessTransport;
  #maximum = Number.POSITIVE_INFINITY;

  constructor(delegate: NodeChildProcessTransport) { this.#delegate = delegate; }
  tighten(maximum: number): void { this.#maximum = maximum; }
  open(handlers: NativeTransportHandlers): Promise<void> { return this.#delegate.open(handlers); }
  close(): Promise<void> { return this.#delegate.close(); }
  write(frame: string): Promise<NativeWriteReceipt> {
    if (Buffer.byteLength(frame, "utf8") > this.#maximum) {
      return Promise.reject(new NativeTransportWriteError("beforeWrite", "Synthetic admission boundary."));
    }
    return this.#delegate.write(frame);
  }
}

test("mutation rejected by immediate admission is beforeWrite/notExecuted", async (context) => {
  // Handshake first through a generously bounded real process transport, then
  // tighten only the contract seam exercised by this client classification.
  const admissionCapBytes = 4_096;
  const processTransport = make(1_048_576);
  const transport = new TightenableAdmissionTransport(processTransport);
  const client = new NativeClient({ transport, runtime: loadStableRuntime });
  context.after(async () => { await client.close().catch(() => {}); });
  await client.connect(loadedProcessDeadlineMs);
  transport.tighten(admissionCapBytes);
  await assert.rejects(client.invoke({ name: "fixture.mutate", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "fixture-host" },
    payload: { value: "x".repeat(admissionCapBytes * 2) },
    timeoutMs: loadedProcessDeadlineMs, codec: jsonResultCodec }), (error: unknown) =>
    error instanceof NativeClientError && error.code === "write_failed"
      && error.writePhase === "beforeWrite" && error.operationOutcome === "notExecuted");
  await client.close();
});

test("mutation handed to stdin then followed by host crash is conservatively unknown", async (context) => {
  const transport = make(1_048_576);
  const client = new NativeClient({ transport, runtime: loadStableRuntime });
  context.after(async () => { await client.close().catch(() => {}); });
  await client.connect(loadedProcessDeadlineMs);
  await assert.rejects(client.invoke({ name: "fixture.mutate", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "fixture-host" }, payload: {},
    timeoutMs: loadedProcessDeadlineMs,
    codec: jsonResultCodec }), (error: unknown) => error instanceof NativeClientError
      && error.code === "disconnected" && error.operationOutcome === "unknown"
      && (error.writePhase === "writing" || error.writePhase === "written"));
  await client.close();
  assert.equal(transport.snapshot().exit?.code, 29);
});
