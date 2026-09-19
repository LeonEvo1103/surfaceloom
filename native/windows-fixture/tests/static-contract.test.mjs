import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runChecked } from "../scripts/bounded-child.mjs";
import {
  deriveGateConcurrency, guardAgainstOwnerOverlap, observeSuccessorAcquisition, recordGateEvent,
} from "../scripts/gate-event-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(await readFile(path.join(root, "fixture-contract.v1.json"), "utf8"));
const xaml = await readFile(
  path.join(root, "src", "SurfaceLoom.WindowsFixture", "MainWindow.xaml"),
  "utf8",
);
const codeBehind = await readFile(
  path.join(root, "src", "SurfaceLoom.WindowsFixture", "MainWindow.xaml.cs"),
  "utf8",
);

async function productionFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "bin" || entry.name === "obj") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionFiles(entryPath)));
    } else if ([".cs", ".csproj", ".xaml"].includes(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

test("XAML exposes every normative automation identity exactly once", () => {
  const identities = [contract.root, ...contract.controls];
  for (const identity of identities) {
    const escaped = identity.automationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = xaml.match(new RegExp(`AutomationId="${escaped}"`, "g")) ?? [];
    assert.equal(matches.length, 1, `${identity.automationId} must occur once in MainWindow.xaml`);
    assert.ok(
      xaml.includes(`AutomationProperties.Name="${identity.name}"`),
      `${identity.automationId} must expose the normative name`,
    );
  }
});

test("event wiring covers every mutating fixture behavior", () => {
  const handlers = [
    ["Click=\"InvokeButton_Click\"", "RecordInvoke()"],
    ["Click=\"AmbiguousButton_Click\"", "RecordAmbiguousInvocation()"],
    ["Click=\"TransientButton_Click\"", "DismissTransient()"],
    ["Click=\"RestoreTransientButton_Click\"", "RestoreTransient()"],
    ["Click=\"CloseButton_Click\"", "BeginClosing()"],
  ];
  for (const [xamlMarker, codeMarker] of handlers) {
    assert.ok(xaml.includes(xamlMarker), `missing XAML handler ${xamlMarker}`);
    assert.ok(codeBehind.includes(codeMarker), `missing state transition ${codeMarker}`);
  }
  assert.ok(xaml.includes('x:Name="TransientHost"'));
  assert.ok(xaml.includes('x:Name="TransientActionButton"'));
  assert.ok(codeBehind.includes("TransientHost.Children.Remove(TransientActionButton)"));
  assert.ok(codeBehind.includes("TransientHost.Children.Insert(0, TransientActionButton)"));
});

test("project is dependency-free, non-elevated, and has no network implementation", async () => {
  const sourceFiles = await productionFiles(path.join(root, "src"));
  const content = await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")));
  const joined = content.join("\n");

  assert.doesNotMatch(joined, /<PackageReference\b/);
  assert.doesNotMatch(joined, /requireAdministrator|highestAvailable/);
  assert.doesNotMatch(joined, /HttpClient|WebRequest|TcpClient|UdpClient|\bSocket\b/);
  assert.doesNotMatch(joined, /EvoMap|EvoX|evomap|evox/);
});

test("app and portable state model keep their target boundaries explicit", async () => {
  const appProject = await readFile(
    path.join(root, "src", "SurfaceLoom.WindowsFixture", "SurfaceLoom.WindowsFixture.csproj"),
    "utf8",
  );
  const modelProject = await readFile(
    path.join(
      root,
      "src",
      "SurfaceLoom.WindowsFixture.Model",
      "SurfaceLoom.WindowsFixture.Model.csproj",
    ),
    "utf8",
  );
  assert.match(appProject, /<TargetFramework>net8\.0-windows<\/TargetFramework>/);
  assert.match(appProject, /<UseWPF>true<\/UseWPF>/);
  assert.match(appProject, /<OutputType>WinExe<\/OutputType>/);
  assert.match(modelProject, /<TargetFramework>net8\.0<\/TargetFramework>/);
  assert.doesNotMatch(modelProject, /-windows/);
});

test("Windows live evidence is gated and written only after confirmed cleanup", async () => {
  const liveRoot = path.join(root, "tests", "SurfaceLoom.WindowsFixture.LiveTests");
  const program = await readFile(path.join(liveRoot, "Program.cs"), "utf8");
  const client = await readFile(path.join(liveRoot, "NativeProcessClient.cs"), "utf8");
  const fixtureSession = await readFile(path.join(liveRoot, "FixtureLiveSession.cs"), "utf8");
  const script = await readFile(path.join(root, "scripts", "live-conformance.ps1"), "utf8");
  const gateRunner = await readFile(path.join(root, "scripts", "run-live-with-gate.mjs"), "utf8");
  const boundedChild = await readFile(path.join(root, "scripts", "bounded-child.mjs"), "utf8");

  assert.ok(program.indexOf("await session.DisposeAsync()") < program.indexOf("File.WriteAllTextAsync"));
  assert.match(program, /cleanupConfirmed = session\.CleanupConfirmed/u);
  assert.doesNotMatch(client, /\.Kill\s*\(/u);
  assert.doesNotMatch(client, /ReadToEndAsync/u);
  assert.match(client, /inherited stderr remained open; cleanup is unconfirmed/u);
  assert.match(fixtureSession, /Fixture or native host cleanup was not confirmed/u);
  assert.ok(script.indexOf('"core", "reporter", "test"')
    < script.indexOf('Invoke-Checked "dotnet" @("build"'));
  assert.match(script, /Language\.Parser\]::ParseFile/u);
  assert.match(script, /\$\{LASTEXITCODE\}:/u);
  assert.match(gateRunner, /acquireWindowsExecutionGuiGate/u);
  assert.match(gateRunner, /new JsonLineChild/u);
  assert.match(gateRunner, /deriveGateConcurrency\(events\)/u);
  assert.doesNotMatch(gateRunner, /successorEnteredOnlyAfterCleanupAndRelease:\s*true/u);
  assert.match(gateRunner, /unconfirmedCleanupBlockedSuccessor,/u);
  assert.ok(gateRunner.indexOf("const changedPaths")
    < gateRunner.indexOf('validateRequestedRevision("SURFACELOOM_HOST_REVISION"'));
  assert.match(boundedChild, /deadlineMs/u);
  assert.match(boundedChild, /inherited output remained open; cleanup is unconfirmed/u);
  assert.match(boundedChild, /stdin\.once\("error"/u);
});

test("live gate ledger rejects an early frame and accepts a genuine post-release frame", async () => {
  const earlyEvents = [];
  const earlyState = { started: false };
  recordGateEvent(earlyEvents, "ownerAcquired", 100n);
  const early = observeSuccessorAcquisition(fakeObservedChild(220n), earlyEvents, earlyState, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  recordGateEvent(earlyEvents, "cleanupConfirmed", 500n);
  earlyState.started = true;
  recordGateEvent(earlyEvents, "ownerReleased", 550n);
  const earlyObservation = await early;
  assert.equal(earlyObservation.enteredBeforeRelease, true);
  await assert.rejects(guardAgainstOwnerOverlap(Promise.resolve(earlyObservation)),
    /still active/u);
  assert.deepEqual(deriveGateConcurrency(earlyEvents), {
    maxConcurrentGuiOwners: 2, successorEnteredOnlyAfterCleanupAndRelease: false,
  });

  const validEvents = [];
  const validState = { started: true };
  recordGateEvent(validEvents, "ownerAcquired", 100n);
  recordGateEvent(validEvents, "cleanupConfirmed", 500n);
  recordGateEvent(validEvents, "ownerReleased", 550n);
  const valid = await observeSuccessorAcquisition(fakeObservedChild(600n), validEvents, validState, 1_000);
  assert.equal(valid.enteredBeforeRelease, false);
  assert.deepEqual(deriveGateConcurrency(validEvents), {
    maxConcurrentGuiOwners: 1, successorEnteredOnlyAfterCleanupAndRelease: true,
  });
});

function fakeObservedChild(monotonicNs) {
  return { nextObserved: async () => ({ value: { type: "acquired" }, monotonicNs }) };
}

test("bounded child runner does not hang when a descendant inherits stderr", async () => {
  const program = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["--eval", "setTimeout(() => {}, 750)"],
      { stdio: ["ignore", "ignore", process.stderr] }).unref();
  `;
  const started = Date.now();
  await assert.rejects(runChecked(process.execPath, ["--eval", program], root,
    { deadlineMs: 2_000, closeGraceMs: 50 }), /inherited output remained open.*unconfirmed/u);
  assert.ok(Date.now() - started < 1_000);
});

test("bounded child harness process exits after finite and infinite inherited pipes", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-bounded-child-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const api of ["runChecked", "JsonLineChild"]) {
    for (const lifetime of ["finite", "infinite"]) {
      const pidFile = path.join(temporary, `${api}-${lifetime}.pid`);
      await assertHarnessExits(api, lifetime, pidFile);
      const descendantPid = Number(await readFile(pidFile, "utf8"));
      if (Number.isSafeInteger(descendantPid)) {
        try { process.kill(descendantPid); } catch { /* finite descendant may already have exited */ }
      }
    }
  }
});

async function assertHarnessExits(api, lifetime, pidFile) {
  const descendant = lifetime === "finite"
    ? "setTimeout(() => {}, 1800)" : "setInterval(() => {}, 1000)";
  const direct = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const target = spawn(process.execPath, ["--eval", ${JSON.stringify(descendant)}],
      { stdio: ["ignore", "ignore", process.stderr] });
    writeFileSync(${JSON.stringify(pidFile)}, String(target.pid));
    target.unref();
  `;
  const moduleUrl = pathToFileURL(path.join(root, "scripts", "bounded-child.mjs")).href;
  const harness = `
    import { JsonLineChild, runChecked } from ${JSON.stringify(moduleUrl)};
    const direct = JSON.parse(process.argv[1]);
    try {
      if (${JSON.stringify(api)} === "runChecked") {
        await runChecked(process.execPath, ["--eval", direct], ${JSON.stringify(root)},
          { deadlineMs: 2000, closeGraceMs: 40 });
      } else {
        const child = new JsonLineChild(process.execPath, ["--eval", direct], ${JSON.stringify(root)});
        await child.expectExit(0, 2000, 40);
      }
      throw new Error("expected inherited-pipe rejection");
    } catch (error) {
      if (!/inherited output remained open.*unconfirmed/i.test(String(error))) throw error;
    }
  `;
  const child = spawn(process.execPath,
    ["--input-type=module", "--eval", harness, JSON.stringify(direct)],
    { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
  const started = Date.now();
  const result = await Promise.race([
    new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve(null), 900)),
  ]);
  if (result === null) child.kill();
  assert.notEqual(result, null, `${api}/${lifetime} harness lingered; stderr=${stderr}`);
  assert.deepEqual(result, { code: 0, signal: null }, `${api}/${lifetime}: ${stderr}`);
  assert.ok(Date.now() - started < 900);
}
