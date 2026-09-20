import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nativeRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(nativeRoot, "../..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "surfaceloom-native-consumer-"));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run through npm so the current npm CLI is available.");
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
const pack = (directory) => {
  const [archive] = JSON.parse(npm(["pack", "--json", "--pack-destination", temporary], directory));
  return { archive, path: path.join(temporary, archive.filename) };
};

try {
  const native = pack(nativeRoot);
  assert(native.archive.files.some(({ path: file }) => file === "dist/windows/index.js"));
  assert(native.archive.files.some(({ path: file }) => file === "dist/windows/v3/index.js"));
  assert(!native.archive.files.some(({ path: file }) => /^(src|tests|node_modules)\//u.test(file)));

  const rootOnly = path.join(temporary, "root-only");
  mkdirSync(rootOnly);
  npm(["init", "-y"], rootOnly);
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    "--omit=optional", native.path], rootOnly);
  assert.equal(existsSync(path.join(rootOnly, "node_modules/@surfaceloom/test")), false);
  writeFileSync(path.join(rootOnly, "consume.mjs"), `
    import { NativeClient } from "@surfaceloom/native";
    import { WindowsNativeController } from "@surfaceloom/native/windows";
    if (typeof NativeClient !== "function" || typeof WindowsNativeController !== "function") process.exit(2);
  `);
  execFileSync(process.execPath, ["consume.mjs"], { cwd: rootOnly, stdio: "inherit" });

  for (const packageName of ["core", "reporter", "llm-judge", "test"]) {
    npm(["run", "build"], path.join(repositoryRoot, "packages", packageName));
  }
  const peer = ["core", "reporter", "llm-judge", "test"].map((name) =>
    pack(path.join(repositoryRoot, "packages", name)).path);
  const withPeer = path.join(temporary, "with-peer");
  mkdirSync(withPeer);
  npm(["init", "-y"], withPeer);
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    ...peer, native.path], withPeer);
  writeFileSync(path.join(withPeer, "consume.mjs"), `
    import { createWindowsNativeSurfaceBackend } from "@surfaceloom/native/windows/v3";
    const backend = createWindowsNativeSurfaceBackend({ hostId: "packed.host",
      process: { executable: process.execPath, cwd: process.cwd(), argv: [] },
      targets: { app: { kind: "launch", options: { executablePath: process.execPath } } } });
    if (backend.hostId !== "packed.host" || backend.backend !== "uia") process.exit(3);
  `);
  execFileSync(process.execPath, ["consume.mjs"], { cwd: withPeer, stdio: "inherit" });
  writeFileSync(path.join(withPeer, "consume.ts"), `
    import type { ApplicationDesktopSession } from "@surfaceloom/native";
    import type { WindowsCoreSession, WindowsDesktopSession } from "@surfaceloom/native/windows";
    declare const owned: WindowsDesktopSession<"owned">;
    declare const borrowed: WindowsDesktopSession<"borrowed">;
    const a: ApplicationDesktopSession<"windows", WindowsCoreSession> = owned;
    const b: ApplicationDesktopSession<"windows", WindowsCoreSession> = borrowed;
    void a; void b; void owned.lifecyclePort.terminate;
    // @ts-expect-error borrowed sessions expose release but no destructive lifecycle port.
    void borrowed.lifecyclePort;
  `);
  writeFileSync(path.join(withPeer, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    noEmit: true, skipLibCheck: true,
  }, include: ["consume.ts"] }));
  execFileSync(process.execPath, [path.join(nativeRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    { cwd: withPeer, stdio: "inherit" });
  console.log("Packed native root, Windows, and Windows v3 peer entrypoints passed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
