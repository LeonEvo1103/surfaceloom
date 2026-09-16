export type NativeWritePhase = "beforeWrite" | "writing" | "written";

export interface NativeTransportHandlers {
  readonly onFrame: (frame: string) => void;
  readonly onDisconnect: (cause?: unknown) => void;
}

export interface NativeWriteReceipt {
  /** UTF-8 bytes accepted by the transport, including the NDJSON delimiter. */
  readonly bytesWritten: number;
}

/**
 * Embeddable byte transport. A transport must deliver exactly one complete
 * NDJSON frame to onFrame. It may preserve or strip the final LF/CRLF; the
 * client counts an implicit LF when it is stripped. Unknown write failures are
 * treated by the client as `writing`, never as `beforeWrite`.
 */
export interface NativeClientTransport {
  open(handlers: NativeTransportHandlers): Promise<void>;
  write(frame: string): Promise<NativeWriteReceipt>;
  close(): Promise<void>;
}

export class NativeTransportWriteError extends Error {
  readonly phase: NativeWritePhase;

  constructor(phase: NativeWritePhase, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeTransportWriteError";
    this.phase = phase;
  }
}
