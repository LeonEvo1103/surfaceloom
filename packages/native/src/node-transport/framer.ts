import { TextDecoder } from "node:util";
import { NodeProcessTransportError } from "./types.js";

export class StdoutFramer {
  readonly #maximum: number;
  readonly #emit: (frame: string) => void;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #ended = false;

  constructor(maximum: number, emit: (frame: string) => void) {
    this.#maximum = maximum;
    this.#emit = emit;
  }

  push(chunk: Buffer): void {
    if (this.#ended) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      const nextBytes = this.#pendingBytes + part.length;
      if (newline < 0 ? nextBytes >= this.#maximum : nextBytes > this.#maximum) this.#tooLarge();
      this.#pending.push(part);
      this.#pendingBytes = nextBytes;
      if (newline >= 0) this.#emitPending();
      offset = end;
    }
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#pendingBytes === 0) return;
    if (this.#pendingBytes + 1 > this.#maximum) this.#tooLarge();
    this.#emitPending();
  }

  abort(): void {
    this.#ended = true;
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  #emitPending(): void {
    const bytes = this.#pending.length === 1 ? this.#pending[0] as Buffer
      : Buffer.concat(this.#pending, this.#pendingBytes);
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#emit(this.#decode(bytes));
  }

  #decode(bytes: Buffer): string {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (cause) {
      throw new NodeProcessTransportError("invalid_utf8", "Native host stdout is not valid UTF-8.", { cause });
    }
  }

  #tooLarge(): never {
    throw new NodeProcessTransportError("frame_too_large", "Native host stdout frame exceeds the byte limit.");
  }
}
