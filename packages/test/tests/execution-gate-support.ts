import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve("dist/execution-gate.js")).href;
const program = `
  import { spawn } from "node:child_process";
  import { acquireWindowsExecutionGuiGateForTest } from ${JSON.stringify(moduleUrl)};
  const config = JSON.parse(process.argv[1]);
  process.stdout.write(JSON.stringify({ type: "waiting" }) + "\\n");
  const gate = await acquireWindowsExecutionGuiGateForTest(config.scope, config.runtime);
  let target;
  if (config.spawnTarget) {
    target = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      detached: true, stdio: "ignore"
    });
    target.unref();
  }
  process.stdout.write(JSON.stringify({ type: "acquired", id: gate.id,
    ...(target ? { targetPid: target.pid } : {}) }) + "\\n");
  process.stdin.setEncoding("utf8");
  let buffered = "";
  process.stdin.on("data", async chunk => {
    buffered += chunk;
    while (buffered.includes("\\n")) {
      const index = buffered.indexOf("\\n");
      const command = buffered.slice(0, index); buffered = buffered.slice(index + 1);
      if (command === "release") {
        const receipt = await gate.release();
        process.stdout.write(JSON.stringify({ type: "released", receipt }) + "\\n");
      } else if (command === "quarantine") {
        await gate.quarantine("injected child quarantine");
        process.stdout.write(JSON.stringify({ type: "quarantined" }) + "\\n");
        process.exitCode = 1;
        process.stdin.destroy();
      } else if (command === "crash") process.exit(1);
    }
  });
`;

interface Waiter { resolve(value: unknown): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> }

export class GateChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly #lines: unknown[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #closed: Promise<number | null>;
  #buffer = "";
  #stderr = "";
  #failure: Error | undefined;
  #isClosed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.process = child;
    this.#closed = new Promise((resolve) => child.once("close", (code) => {
      this.#isClosed = true;
      this.fail(new Error(`Gate child closed; stderr=${redact(this.#stderr)}`));
      resolve(code);
    }));
    child.once("error", (error) => this.fail(new Error(`Gate child error: ${error.message}`)));
    child.stdin.once("error", (error) => this.fail(new Error(`Gate child stdin error: ${error.message}`)));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => { this.#stderr = tail(this.#stderr + chunk); });
  }

  static start(config: object): GateChild {
    return new GateChild(spawn(process.execPath,
      ["--input-type=module", "--eval", program, JSON.stringify(config)],
      { shell: false, stdio: ["pipe", "pipe", "pipe"] }));
  }

  next(timeoutMs = 5_000): Promise<unknown> {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift());
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("Timed out waiting for gate child output."));
      }, timeoutMs) };
      this.#waiters.push(waiter);
    });
  }

  send(command: "release" | "quarantine" | "crash"): void {
    if (this.#isClosed) throw new Error("Gate child is closed.");
    const done = (error?: Error | null) => { if (error) this.fail(error); };
    this.process.stdin.write(`${command}\n`, done);
  }

  waitForExit(): Promise<number | null> { return this.#closed; }

  async terminate(): Promise<void> {
    if (!this.#isClosed) this.process.kill();
    await this.#closed;
  }

  private consume(chunk: string): void {
    this.#buffer += chunk;
    while (this.#buffer.includes("\n")) {
      const index = this.#buffer.indexOf("\n");
      const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { this.fail(new Error("Gate child emitted invalid JSON.")); return; }
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#lines.push(value);
      else { clearTimeout(waiter.timer); waiter.resolve(value); }
    }
  }

  private fail(error: Error): void {
    this.#failure ??= error;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer); waiter.reject(this.#failure);
    }
  }
}

function tail(value: string): string { return value.slice(-8_192); }
function redact(value: string): string {
  return value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, "<uuid>")
    .replace(/(?:[A-Za-z]:\\|\/)[^\r\n"']+/gu, "<path>").slice(-2_048);
}
