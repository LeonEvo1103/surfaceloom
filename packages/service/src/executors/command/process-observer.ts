import type { Readable } from "node:stream";

import { BoundedOutput, safeErrorMessage } from "./bounded-output.js";
import type {
  CommandChild, ProcessExitReceipt, ProcessIdentityReceipt, StdioReceipt,
} from "./contracts.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export class ProcessObserver {
  readonly #instanceId: string;
  readonly #stdout: BoundedOutput;
  readonly #stderr: BoundedOutput;
  readonly #exit = deferred<ProcessExitReceipt>();
  readonly #stdio = deferred<void>();
  readonly #failure = deferred<string>();
  #spawnObserved = false;
  #pid: number | null = null;
  #exitReceipt: ProcessExitReceipt | null = null;
  #stdoutTerminal = false;
  #stderrTerminal = false;
  #childCloseObserved = false;
  #failureMessage: string | null = null;

  constructor(instanceId: string, stdoutLimit: number, stderrLimit: number) {
    this.#instanceId = instanceId;
    this.#stdout = new BoundedOutput(stdoutLimit);
    this.#stderr = new BoundedOutput(stderrLimit);
  }

  attach(child: CommandChild): void {
    this.#pid = child.pid ?? null;
    this.#wireStream(child.stdout, this.#stdout, () => {
      this.#stdoutTerminal = true;
      this.#settleStdio();
    });
    this.#wireStream(child.stderr, this.#stderr, () => {
      this.#stderrTerminal = true;
      this.#settleStdio();
    });
    child.once("spawn", () => {
      this.#spawnObserved = true;
      this.#pid = child.pid ?? this.#pid;
    });
    child.once("error", (error: unknown) => {
      const message = safeErrorMessage(error);
      this.#settleFailure(message);
      if (!this.#spawnObserved) this.settleNotSpawned();
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.#settleExit(Object.freeze({
        status: "exited",
        instanceId: this.#instanceId,
        pid: this.#pid,
        code,
        signal,
      }));
    });
    child.once("close", () => { this.#childCloseObserved = true; });
  }

  get exitPromise(): Promise<ProcessExitReceipt> { return this.#exit.promise; }
  get stdioPromise(): Promise<void> { return this.#stdio.promise; }
  get failurePromise(): Promise<string> { return this.#failure.promise; }
  get exitReceipt(): ProcessExitReceipt | null { return this.#exitReceipt; }
  get failureMessage(): string | null { return this.#failureMessage; }
  get stdioTerminal(): boolean { return this.#stdoutTerminal && this.#stderrTerminal; }

  settleNotSpawned(): void {
    this.#settleExit(Object.freeze({ status: "not-spawned" }));
  }

  settleUnconfirmed(detail: string): void {
    this.#settleExit(Object.freeze({ status: "unconfirmed", detail }));
  }

  identity(): ProcessIdentityReceipt {
    return Object.freeze({
      instanceId: this.#instanceId,
      status: this.#spawnObserved ? "spawn-observed" :
        this.#exitReceipt?.status === "not-spawned" ? "not-spawned" : "spawn-unconfirmed",
      pid: this.#pid,
    });
  }

  stdioReceipt(): StdioReceipt {
    return Object.freeze({
      stdout: this.#stdout.receipt(),
      stderr: this.#stderr.receipt(),
      childCloseObserved: this.#childCloseObserved,
    });
  }

  #wireStream(stream: Readable, output: BoundedOutput, terminal: () => void): void {
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      output.terminal(error);
      terminal();
      if (error !== undefined) this.#settleFailure(safeErrorMessage(error));
    };
    stream.on("data", (chunk: Buffer | string) => output.push(chunk));
    stream.once("end", () => settle());
    stream.once("close", () => settle());
    stream.once("error", (error: unknown) => settle(error));
  }

  #settleExit(receipt: ProcessExitReceipt): void {
    if (this.#exitReceipt !== null) return;
    this.#exitReceipt = receipt;
    this.#exit.resolve(receipt);
  }

  #settleFailure(message: string): void {
    if (this.#failureMessage !== null) return;
    this.#failureMessage = message;
    this.#failure.resolve(message);
  }

  #settleStdio(): void {
    if (this.#stdoutTerminal && this.#stderrTerminal) this.#stdio.resolve();
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
