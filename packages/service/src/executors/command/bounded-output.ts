import { StringDecoder } from "node:string_decoder";

import type { OutputReceipt } from "./contracts.js";

export class BoundedOutput {
  readonly #limit: number;
  readonly #retained: Buffer;
  #bytesSeen = 0;
  #bytesRetained = 0;
  #terminal = false;
  #error: string | undefined;

  constructor(limit: number) {
    this.#limit = limit;
    this.#retained = Buffer.allocUnsafe(limit);
  }

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.#bytesSeen += bytes.byteLength;
    const remaining = this.#limit - this.#bytesRetained;
    if (remaining <= 0) return;
    const retained = bytes.subarray(0, Math.min(remaining, bytes.byteLength));
    retained.copy(this.#retained, this.#bytesRetained);
    this.#bytesRetained += retained.byteLength;
  }

  terminal(error?: unknown): void {
    this.#terminal = true;
    if (error !== undefined) this.#error = safeErrorMessage(error);
  }

  receipt(): OutputReceipt {
    const decoder = new StringDecoder("utf8");
    const text = decoder.write(this.#retained.subarray(0, this.#bytesRetained)) + decoder.end();
    return Object.freeze({
      text,
      bytesSeen: this.#bytesSeen,
      bytesRetained: this.#bytesRetained,
      truncated: this.#bytesSeen > this.#bytesRetained,
      terminal: this.#terminal,
      ...(this.#error === undefined ? {} : { error: this.#error }),
    });
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error.";
}
