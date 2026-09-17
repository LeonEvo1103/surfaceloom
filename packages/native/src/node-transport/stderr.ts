import { StringDecoder } from "node:string_decoder";

const lineLimit = 4_096;

function redact(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}

function tailBytes(value: string, maximum: number): string {
  if (maximum === 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  const reversed: string[] = [];
  let size = 0;
  for (let offset = value.length; offset > 0;) {
    const low = value.charCodeAt(offset - 1);
    const width = low >= 0xdc00 && low <= 0xdfff && offset > 1 ? 2 : 1;
    const character = value.slice(offset - width, offset);
    const bytes = Buffer.byteLength(character, "utf8");
    if (size + bytes > maximum) break;
    reversed.push(character);
    size += bytes;
    offset -= width;
  }
  return reversed.reverse().join("");
}

export class BoundedStderr {
  readonly #maximum: number;
  readonly #decoder = new StringDecoder("utf8");
  #pending = "";
  #tail = "";
  #bytesSeen = 0;
  #truncated = false;
  #discardingLongLine = false;

  constructor(maximum: number) { this.#maximum = maximum; }
  get bytesSeen(): number { return this.#bytesSeen; }
  get tail(): string { return tailBytes(`${this.#tail}${redact(this.#pending)}`, this.#maximum); }
  get truncated(): boolean { return this.#truncated || this.#bytesSeen > this.#maximum; }

  push(chunk: Buffer): void {
    this.#bytesSeen += chunk.length;
    let decoded = this.#decoder.write(chunk);
    if (this.#discardingLongLine) {
      const newline = decoded.indexOf("\n");
      if (newline < 0) return;
      decoded = decoded.slice(newline + 1);
      this.#discardingLongLine = false;
    }
    this.#pending += decoded;
    this.#flushLines();
    if (Buffer.byteLength(this.#pending, "utf8") > lineLimit) {
      this.#truncated = true;
      this.#append("[stderr line redacted]\n");
      this.#pending = "";
      this.#discardingLongLine = true;
    }
  }

  end(): void {
    const remainder = this.#decoder.end();
    if (!this.#discardingLongLine) this.#pending += remainder;
    if (this.#pending.length > 0) this.#append(redact(this.#pending));
    this.#pending = "";
  }

  #flushLines(): void {
    let newline: number;
    while ((newline = this.#pending.indexOf("\n")) >= 0) {
      const line = this.#pending.slice(0, newline + 1);
      if (Buffer.byteLength(line, "utf8") > lineLimit) {
        this.#truncated = true;
        this.#append("[stderr line redacted]\n");
      } else this.#append(redact(line));
      this.#pending = this.#pending.slice(newline + 1);
    }
  }

  #append(value: string): void {
    if (Buffer.byteLength(this.#tail + value, "utf8") > this.#maximum) this.#truncated = true;
    this.#tail = tailBytes(this.#tail + value, this.#maximum);
  }
}
