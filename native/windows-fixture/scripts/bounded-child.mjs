import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 65_536;

export async function runChecked(command, args, cwd, options = {}) {
  const { echo = false, deadlineMs = 120_000, closeGraceMs = 500 } = options;
  const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const events = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { if (echo) process.stdout.write(chunk); stdout = tail(stdout + chunk); });
  child.stderr.on("data", (chunk) => { if (echo) process.stderr.write(chunk); stderr = tail(stderr + chunk); });
  child.once("spawn", () => events.push("spawn"));
  const result = await new Promise((resolve) => {
    let settled = false;
    let exitResult;
    let closeGrace;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(closeGrace);
      resolve(value);
    };
    const deadline = setTimeout(() => {
      events.push("timeout");
      child.kill(); // containment only; never interpreted as cleanup proof
      finish({ code: null, signal: null, timedOut: true, closeObserved: false });
    }, deadlineMs);
    child.once("error", (error) => {
      events.push(`error:${error.code ?? "unknown"}`);
      finish({ code: null, signal: null, error, timedOut: false, closeObserved: false });
    });
    child.once("exit", (code, signal) => {
      events.push(`exit:${code ?? "null"}:${signal ?? "none"}`);
      exitResult = { code, signal, timedOut: false, closeObserved: false };
      closeGrace = setTimeout(() => finish(exitResult), closeGraceMs);
    });
    child.once("close", (code, signal) => {
      events.push(`close:${code ?? "null"}:${signal ?? "none"}`);
      finish({ code, signal, timedOut: false, closeObserved: true });
    });
  });
  if (!result.closeObserved) detachParentIo(child);
  const diagnostic = `events=[${events.join(",")}], stderr=${redact(stderr.trim()) || "<empty>"}`;
  if (result.timedOut) throw new Error(`${command} exceeded its deadline; cleanup is unconfirmed. ${diagnostic}`);
  if (result.error) throw new Error(`${command} failed to spawn. ${diagnostic}`);
  if (!result.closeObserved) {
    throw new Error(`${command} exited but inherited output remained open; cleanup is unconfirmed. ${diagnostic}`);
  }
  if (result.signal !== null) throw new Error(`${command} stopped by signal. ${diagnostic}`);
  if (result.code !== 0) throw new Error(`${command} failed with exit code ${result.code}. ${diagnostic}`);
  return { code: result.code, stdout, diagnostic };
}

export class JsonLineChild {
  #child;
  #lines = [];
  #waiters = [];
  #buffer = "";
  #stderr = "";
  #events = [];
  #failure;
  #exit;
  #close;

  constructor(command, args, cwd) {
    this.#child = spawn(command, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.#exit = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      this.#child.once("error", (error) => {
        this.#events.push(`error:${error.code ?? "unknown"}`); this.#fail(error); finish({ code: null });
      });
      this.#child.once("exit", (code, signal) => {
        this.#events.push(`exit:${code ?? "null"}:${signal ?? "none"}`);
        this.#fail(new Error("Contender exited before completing its protocol.")); finish({ code, signal });
      });
    });
    this.#close = new Promise((resolve) => this.#child.once("close", (code, signal) => {
      this.#events.push(`close:${code ?? "null"}:${signal ?? "none"}`); resolve({ code, signal });
    }));
    this.#child.once("spawn", () => this.#events.push("spawn"));
    this.#child.stdin.once("error", (error) => this.#fail(error));
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.on("data", (chunk) => { this.#stderr = tail(this.#stderr + chunk); });
  }

  next(deadlineMs = 30_000) {
    return this.nextObserved(deadlineMs).then((observed) => observed.value);
  }

  nextObserved(deadlineMs = 30_000) {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift());
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`Contender protocol timed out. ${this.diagnostic()}`));
      }, deadlineMs) };
      this.#waiters.push(waiter);
    });
  }

  send(command) {
    this.#child.stdin.write(`${command}\n`, (error) => { if (error) this.#fail(error); });
  }

  containUnconfirmed() {
    this.#events.push("containment-kill");
    this.#child.kill();
  }

  async expectExit(code, deadlineMs = 5_000, closeGraceMs = 500) {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error("Contender exit timed out; cleanup is unconfirmed."));
        this.#detachParentIo();
        reject(new Error(`Contender exit timed out; cleanup is unconfirmed. ${this.diagnostic()}`));
      }, deadlineMs);
      this.#exit.then((value) => { clearTimeout(timer); resolve(value); }, (error) => {
        clearTimeout(timer); reject(error);
      });
    });
    if (result.code !== code) {
      this.#detachParentIo();
      throw new Error(`Contender exit code changed. ${this.diagnostic()}`);
    }
    const closeObserved = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), closeGraceMs);
      this.#close.then(() => { clearTimeout(timer); resolve(true); });
    });
    if (!closeObserved) {
      this.#fail(new Error("Contender inherited output remained open; cleanup is unconfirmed."));
      this.#detachParentIo();
      throw new Error(`Contender exited but inherited output remained open; cleanup is unconfirmed. ${this.diagnostic()}`);
    }
    this.#detachParentIo();
  }

  diagnostic() { return `events=[${this.#events.join(",")}], stderr=${redact(this.#stderr) || "<empty>"}`; }

  #consume(chunk) {
    this.#buffer += chunk;
    while (this.#buffer.includes("\n")) {
      const index = this.#buffer.indexOf("\n");
      const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1);
      let value;
      try { value = JSON.parse(line); } catch { this.#fail(new Error("Contender emitted invalid JSON.")); return; }
      const observed = Object.freeze({ value, monotonicNs: process.hrtime.bigint() });
      const waiter = this.#waiters.shift();
      if (!waiter) this.#lines.push(observed);
      else { clearTimeout(waiter.timer); waiter.resolve(observed); }
    }
  }

  #fail(error) {
    this.#failure ??= error;
    for (const waiter of this.#waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(this.#failure); }
  }

  #detachParentIo() { detachParentIo(this.#child); }
}

function detachParentIo(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.destroy();
    if (typeof stream?.unref === "function") stream.unref();
  }
  child.unref();
}

function tail(value) { return value.length <= OUTPUT_LIMIT ? value : value.slice(-OUTPUT_LIMIT); }
function redact(value) {
  return value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, "<uuid>")
    .replace(/(?:[A-Za-z]:\\|\/)[^\r\n"']+/gu, "<path>")
    .replace(/(token|secret|password)\s*[=:]\s*\S+/giu, "$1=<redacted>").slice(-4_096);
}
