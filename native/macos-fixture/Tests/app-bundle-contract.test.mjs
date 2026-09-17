import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appName = "SurfaceLoomMacOSFixture.app";
const executableName = "SurfaceLoomMacOSFixture";
const bundleId = "dev.surfaceloom.fixture.macos";
const defaultApp = path.join(root, "build", "artifacts", appName);

async function readPlist(plistPath) {
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]);
  return JSON.parse(stdout);
}

async function assertBundle(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
  const contractPath = path.join(appPath, "Contents", "Resources", "fixture-contract.v1.json");
  const [plist, executable, embeddedContract, sourceContract] = await Promise.all([
    readPlist(plistPath),
    stat(executablePath),
    readFile(contractPath, "utf8"),
    readFile(path.join(root, "fixture-contract.v1.json"), "utf8"),
  ]);

  assert.equal(plist.CFBundleIdentifier, bundleId);
  assert.equal(plist.CFBundleExecutable, executableName);
  assert.equal(plist.CFBundlePackageType, "APPL");
  assert.equal(plist.LSMinimumSystemVersion, "13.0");
  assert.equal(plist.NSPrincipalClass, "NSApplication");
  assert.equal(executable.isFile(), true);
  assert.notEqual(executable.mode & 0o111, 0, "bundle executable must retain an execute bit");
  assert.equal(embeddedContract, sourceContract);
  for (const key of [
    "NSAccessibilityUsageDescription",
    "NSAppleEventsUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]) {
    assert.equal(Object.hasOwn(plist, key), false, `${key} must not imply fixture permission access`);
  }
}

test("checked-in Info.plist fixes bundle identity and minimum OS", async () => {
  const source = await readPlist(path.join(root, "AppBundle", "Info.plist"));
  assert.equal(source.CFBundleIdentifier, bundleId);
  assert.equal(source.CFBundleExecutable, executableName);
  assert.equal(source.CFBundlePackageType, "APPL");
  assert.equal(source.LSMinimumSystemVersion, "13.0");
});

test("verify produces a structurally valid app without launching it", async () => {
  await assertBundle(defaultApp);
  const executablePath = path.join(
    defaultApp,
    "Contents",
    "MacOS",
    executableName,
  );
  const [{ stdout: fileOutput }, { stdout: loadCommands }] = await Promise.all([
    execFileAsync("/usr/bin/file", ["-b", executablePath]),
    execFileAsync("/usr/bin/otool", ["-l", executablePath]),
  ]);
  assert.match(fileOutput, /Mach-O/);
  assert.match(loadCommands, /\bminos 13\.0\b|\bversion 13\.0\b/,
    "Mach-O deployment target must match LSMinimumSystemVersion");
});

test("builder is repeatable from source and output paths containing spaces", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "SurfaceLoom fixture bundle "));
  const copiedRoot = path.join(temporaryRoot, "fixture source with spaces");
  const artifactRoot = path.join(temporaryRoot, "artifact output with spaces");
  try {
    await cp(root, copiedRoot, {
      recursive: true,
      filter: (source) => ![".build", "build", ".swiftpm"].includes(path.basename(source)),
    });
    const builder = path.join(copiedRoot, "scripts", "build-app.sh");
    const environment = { ...process.env, SURFACELOOM_FIXTURE_ARTIFACT_ROOT: artifactRoot };
    await execFileAsync(builder, [], { env: environment });
    await execFileAsync(builder, [], { env: environment });
    const copiedApp = path.join(artifactRoot, appName);
    await assertBundle(copiedApp);
    const entries = await readdir(artifactRoot);
    assert.deepEqual(entries, [appName], "repeat packaging must not leave staging directories");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
