import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { InteractiveSessionLeaseClaim } from "../src/interactive-session.js";

const moduleUrl = pathToFileURL(path.resolve("dist/interactive-session.js")).href;
const MAX_STDERR = 8_192;
const ownerProgram = `
  import { acquireInteractiveSessionLease } from ${JSON.stringify(moduleUrl)};
  const lease = await acquireInteractiveSessionLease({
    directory: process.argv[1], name: process.argv[2], timeoutMs: 2000
  });
  process.stdout.write(JSON.stringify({ type: "acquired", claim: lease }) + "\\n");
  process.stdin.setEncoding("utf8");
  let buffered = "";
  process.stdin.on("data", async chunk => {
    buffered += chunk;
    while (buffered.includes("\\n")) {
      const index = buffered.indexOf("\\n");
      const command = buffered.slice(0, index); buffered = buffered.slice(index + 1);
      if (command === "release") {
        const receipt = await lease.release();
        process.stdout.write(JSON.stringify({ type: "released", receipt }) + "\\n");
      } else if (command === "exit") process.exit(0);
    }
  });
`;

interface Waiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class LeaseChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly #lines: unknown[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #events: string[] = [];
  readonly #closed: Promise<void>;
  #buffer = "";
  #stderr = "";
  #failure: Error | undefined;
  #isClosed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.process = child;
    this.#closed = new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      child.once("close", (code, signal) => {
        this.#events.push(`close:${code ?? "null"}:${signal ?? "none"}`);
        this.#isClosed = true;
        this.failPending(new Error(`Lease child closed before producing output. ${this.diagnostics()}`));
        finish();
      });
      child.once("exit", (code, signal) => {
        this.#events.push(`exit:${code ?? "null"}:${signal ?? "none"}`);
        this.#isClosed = true;
        this.failPending(new Error(`Lease child exited before producing output. ${this.diagnostics()}`));
        finish();
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        this.#events.push(`error:${error.code ?? "unknown"}`);
        this.#isClosed = true;
        this.failPending(new Error(`Lease child failed to start. ${this.diagnostics()}`));
        finish();
      });
    });
    child.once("spawn", () => this.#events.push("spawn"));
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      this.#events.push(`stdin-error:${error.code ?? "unknown"}`);
      this.failPending(new Error(`Lease child stdin failed. ${this.diagnostics()}`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.#stderr = boundedTail(this.#stderr + chunk); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
  }

  static async start(directory: string, name = "interactive-session"): Promise<LeaseChild> {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", ownerProgram, directory, name], {
      shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    const harness = new LeaseChild(child);
    try {
      const first = await harness.next();
      if (!isRecord(first) || first.type !== "acquired") {
        throw new Error(`Lease child emitted an unexpected startup frame. ${harness.diagnostics()}`);
      }
      harness.#lines.unshift(first);
      return harness;
    } catch (error) {
      await harness.terminate();
      throw error;
    }
  }

  send(command: "release" | "exit"): void {
    if (this.#isClosed || this.#failure !== undefined) {
      throw new Error(`Cannot write to an unavailable lease child. ${this.diagnostics()}`);
    }
    this.process.stdin.write(`${command}\n`, (error) => {
      if (error !== null && error !== undefined) {
        this.failPending(new Error(`Lease child command write failed. ${this.diagnostics()}`));
      }
    });
  }

  next(timeoutMs = 5_000): Promise<unknown> {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift());
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for lease child output. ${this.diagnostics()}`));
      }, timeoutMs) };
      this.#waiters.push(waiter);
    });
  }

  async waitForExit(): Promise<void> { await this.#closed; }

  async terminate(): Promise<void> {
    if (!this.#isClosed && this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill();
    }
    await this.#closed;
  }

  private consume(chunk: string): void {
    this.#buffer += chunk;
    while (this.#buffer.includes("\n")) {
      const index = this.#buffer.indexOf("\n");
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      let value: unknown;
      try { value = JSON.parse(line); }
      catch {
        this.failPending(new Error(`Lease child emitted invalid JSON. ${this.diagnostics()}`));
        if (!this.#isClosed) this.process.kill();
        return;
      }
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#lines.push(value);
      else { clearTimeout(waiter.timer); waiter.resolve(value); }
    }
  }

  private failPending(error: Error): void {
    this.#failure ??= error;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.#failure);
    }
  }

  private diagnostics(): string {
    const stderr = redact(this.#stderr.trim());
    return `events=[${this.#events.slice(-12).join(",")}], stderr=${stderr || "<empty>"}`;
  }
}

export async function attemptForeignRelease(claim: InteractiveSessionLeaseClaim): Promise<unknown> {
  const program = `
    import { releaseInteractiveSessionLease } from ${JSON.stringify(moduleUrl)};
    let source = "";
    for await (const chunk of process.stdin) source += chunk;
    try { await releaseInteractiveSessionLease(JSON.parse(source)); }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
    shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const events: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout = boundedTail(stdout + chunk); });
  child.stderr.on("data", (chunk: string) => { stderr = boundedTail(stderr + chunk); });
  child.once("spawn", () => events.push("spawn"));
  child.once("error", (error: NodeJS.ErrnoException) => events.push(`error:${error.code ?? "unknown"}`));
  child.stdin.once("error", (error: NodeJS.ErrnoException) =>
    events.push(`stdin-error:${error.code ?? "unknown"}`));
  child.stdin.end(JSON.stringify(claim), (error?: Error | null) => {
    if (error) events.push("stdin-end-error");
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ code, signal }); }
    };
    const timer = setTimeout(() => { events.push("timeout"); child.kill(); finish(null, "SIGTERM"); }, 5_000);
    child.once("error", () => finish(null, null));
    child.once("exit", (code, signal) => {
      events.push(`exit:${code ?? "null"}:${signal ?? "none"}`);
      setTimeout(() => finish(code, signal), 100);
    });
    child.once("close", (code, signal) => {
      events.push(`close:${code ?? "null"}:${signal ?? "none"}`); finish(code, signal);
    });
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`Foreign release child failed. events=[${events.join(",")}], stderr=${redact(stderr)}`);
  }
  try { return JSON.parse(stdout); }
  catch { throw new Error(`Foreign release child emitted invalid JSON. events=[${events.join(",")}]`); }
}

function boundedTail(value: string): string { return value.length <= MAX_STDERR ? value : value.slice(-MAX_STDERR); }
function redact(value: string): string {
  return value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, "<uuid>")
    .replace(/(?:[A-Za-z]:\\|\/)[^\r\n"']+/gu, "<path>").slice(-2_048);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
