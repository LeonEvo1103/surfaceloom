import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";

export type ProcessIdentityObservation =
  | { readonly status: "absent" }
  | { readonly status: "unknown" }
  | { readonly status: "present"; readonly creationMarker: string };

export interface LinuxProcessRuntime {
  readonly readFile: (path: string) => Promise<string>;
}

const linuxRuntime: LinuxProcessRuntime = Object.freeze({
  readFile: (path: string) => readFile(path, "utf8"),
});

export async function observeLinuxProcessIdentity(pid: number,
  runtime: LinuxProcessRuntime = linuxRuntime): Promise<ProcessIdentityObservation> {
  let stat: string;
  try {
    stat = await runtime.readFile(`/proc/${pid}/stat`);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { status: "absent" } : { status: "unknown" };
  }
  let bootId: string;
  try { bootId = await runtime.readFile("/proc/sys/kernel/random/boot_id"); }
  catch { return { status: "unknown" }; }
  const close = stat.lastIndexOf(")");
  const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
  const startTicks = fields[19]; // proc(5): field 22; fields begins at field 3.
  if (startTicks === undefined || !/^\d+$/u.test(startTicks)) return { status: "unknown" };
  return { status: "present", creationMarker: `linux:${bootId.trim()}:${startTicks}` };
}

function commandMarker(command: string, args: readonly string[], prefix: string,
  pid: number): Promise<ProcessIdentityObservation> {
  return new Promise((resolve) => {
    let output = "";
    let exceeded = false;
    let settled = false;
    const child = spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const finish = (value: ProcessIdentityObservation): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      exceeded = true;
      child.kill();
      finish({ status: "unknown" });
    }, 2_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1_024) {
        exceeded = true;
        child.kill();
      }
    });
    child.once("error", () => finish({ status: "unknown" }));
    child.once("close", (code) => {
      if (exceeded) { finish({ status: "unknown" }); return; }
      const marker = output.trim();
      if (code === 0 && marker.length > 0 && marker.length <= 256 && !/[\r\n]/u.test(marker)) {
        finish({ status: "present", creationMarker: `${prefix}:${marker}` });
      } else {
        finish(processExists(pid) ? { status: "unknown" } : { status: "absent" });
      }
    });
  });
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isMissingProcess(error); }
}

function isMissingProcess(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code : undefined;
}

export async function observeProcessIdentity(pid: number): Promise<ProcessIdentityObservation> {
  if (process.platform === "linux") return observeLinuxProcessIdentity(pid);
  if (process.platform === "darwin") {
    return commandMarker("/bin/ps", ["-p", String(pid), "-o", "lstart="], "darwin", pid);
  }
  if (process.platform === "win32") {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    return commandMarker("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], "win32", pid);
  }
  return { status: "unknown" };
}

export async function currentProcessCreationMarker(): Promise<string | null> {
  const observation = await observeProcessIdentity(process.pid);
  return observation.status === "present" ? observation.creationMarker : null;
}
