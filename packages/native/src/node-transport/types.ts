import type { NativeClientTransport } from "../client/transport.js";

export type NodeProcessTransportState = "idle" | "opening" | "open" | "closing" | "closed";

export type NodeProcessTransportIssueCode = "invalid_options" | "not_open" | "backpressure"
  | "spawn_failed" | "process_exited" | "stdout_closed" | "invalid_utf8"
  | "frame_too_large" | "stream_error" | "startup_timeout" | "write_timeout"
  | "close_unconfirmed";

export class NodeProcessTransportError extends Error {
  readonly code: NodeProcessTransportIssueCode;

  constructor(code: NodeProcessTransportIssueCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeProcessTransportError";
    this.code = code;
  }
}

export interface NodeProcessTransportOptions {
  readonly executable: string;
  readonly cwd: string;
  readonly argv?: readonly string[];
  /** The child receives only these explicit values plus inheritEnvAllowlist. */
  readonly env?: Readonly<Record<string, string>>;
  readonly inheritEnvAllowlist?: readonly string[];
  readonly maxFrameBytes?: number;
  readonly maxOutstandingWriteBytes?: number;
  readonly maxStderrBytes?: number;
  readonly closeGraceMs?: number;
  readonly startupTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly forceCloseMs?: number;
}

export interface ExitedProcessReceipt {
  readonly status: "exited";
  readonly childInstanceId: string;
  readonly pid: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type ProcessExitReceipt = Readonly<{ readonly status: "notSpawned" }>
  | ExitedProcessReceipt | Readonly<{ readonly status: "unconfirmed"; readonly reason: string }>;

export interface NodeProcessLifecycleSnapshot {
  readonly state: NodeProcessTransportState;
  readonly childInstanceId: string | null;
  readonly pid: number | null;
  readonly spawned: boolean;
  readonly processExitObserved: boolean;
  readonly stdioClosed: boolean;
  readonly acceptingWrites: boolean;
  readonly outstandingWriteBytes: number;
  readonly stderrBytesSeen: number;
  readonly stderrTail: string;
  readonly stderrTruncated: boolean;
  readonly exit: ProcessExitReceipt | null;
  readonly disconnectNotified: boolean;
}

export interface NodeProcessTransportContract extends NativeClientTransport {
  snapshot(): NodeProcessLifecycleSnapshot;
  waitForExit(): Promise<ProcessExitReceipt>;
}
