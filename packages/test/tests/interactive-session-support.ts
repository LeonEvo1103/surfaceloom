import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { InteractiveSessionLeaseClaim } from "../src/interactive-session.js";

const moduleUrl = pathToFileURL(path.resolve("dist/interactive-session.js")).href;
const ownerProgram = `
  import { acquireInteractiveSessionLease } from ${JSON.stringify(moduleUrl)};
  const lease = await acquireInteractiveSessionLease({ directory: process.argv[1], timeoutMs: 2000 });
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

export class LeaseChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly #lines: unknown[] = [];
  readonly #waiters: Array<(value: unknown) => void> = [];
  #buffer = "";

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      while (this.#buffer.includes("\n")) {
        const index = this.#buffer.indexOf("\n");
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        const value: unknown = JSON.parse(line);
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#lines.push(value); else waiter(value);
      }
    });
  }

  static async start(directory: string): Promise<LeaseChild> {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", ownerProgram, directory], {
      shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    const harness = new LeaseChild(child);
    const first = await harness.next();
    if ((first as { type?: unknown }).type !== "acquired") throw new Error("Lease child did not acquire its lease.");
    harness.#lines.unshift(first);
    return harness;
  }

  send(command: "release" | "exit"): void { this.process.stdin.write(`${command}\n`); }

  next(timeoutMs = 5_000): Promise<unknown> {
    const queued = this.#lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for lease child output.")), timeoutMs);
      this.#waiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }

  async waitForExit(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    await once(this.process, "close");
  }

  async terminate(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill();
    await this.waitForExit();
  }
}

export async function attemptForeignRelease(claim: InteractiveSessionLeaseClaim): Promise<unknown> {
  const program = `
    import { releaseInteractiveSessionLease } from ${JSON.stringify(moduleUrl)};
    try { await releaseInteractiveSessionLease(JSON.parse(process.argv[1])); }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program, JSON.stringify(claim)], {
    shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  const [code] = await once(child, "close") as [number | null];
  if (code !== 0) throw new Error("Foreign release child failed unexpectedly.");
  return JSON.parse(stdout);
}
