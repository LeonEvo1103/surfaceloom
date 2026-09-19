#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JsonLineChild, runChecked } from "./bounded-child.mjs";
import {
  deriveGateConcurrency, guardAgainstOwnerOverlap, observeSuccessorAcquisition, recordGateEvent,
} from "./gate-event-ledger.mjs";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(fixtureRoot, "..", "..");
const testRoot = path.join(repositoryRoot, "packages", "test");
const testEntry = pathToFileURL(path.join(testRoot, "dist", "index.js")).href;

if (process.argv[2] === "--contender") {
  await contenderMain();
  process.exit(0);
}

const [hostExe, fixtureExe, reportPath, evidencePath, liveProject] = process.argv.slice(2);
if (process.platform !== "win32" || [hostExe, fixtureExe, reportPath, evidencePath, liveProject]
  .some((value) => typeof value !== "string" || value.length === 0)) {
  throw new Error("Usage on Windows: <host-exe> <fixture-exe> <report> <evidence> <live-project>.");
}

const sessionId = integerEnvironment("SURFACELOOM_WINDOWS_SESSION_ID");
const desktop = requiredEnvironment("SURFACELOOM_WINDOWS_DESKTOP").trim().toLowerCase();
if (desktop !== "default") throw new Error("Windows live conformance requires the default desktop.");
const userSid = requiredEnvironment("SURFACELOOM_WINDOWS_USER_SID");
requiredEnvironment("LOCALAPPDATA");
const { acquireWindowsExecutionGuiGate } = await import(testEntry);

await rm(reportPath, { force: true });
await rm(evidencePath, { force: true });
const contract = await runChecked(process.execPath,
  [path.join(testRoot, "node_modules", "tsx", "dist", "cli.mjs"), "--test",
    "tests/interactive-session.test.ts", "tests/interactive-session-storage.test.ts",
    "tests/execution-gate.test.ts", "tests/execution-gate-aba.test.ts"], testRoot,
  { echo: true, deadlineMs: 180_000 });
const contractTests = tapCount(contract.stdout, "tests");
const contractSkipped = tapCount(contract.stdout, "skipped");
if (contractSkipped !== 0) throw new Error("Interactive-session contracts skipped required evidence.");
const unconfirmedCleanupBlockedSuccessor =
  /ok \d+ - unconfirmed host cleanup persists quarantine and blocks a successor/mu.test(contract.stdout);
if (!unconfirmedCleanupBlockedSuccessor) {
  throw new Error("Contract output omitted the unconfirmed-cleanup successor barrier proof.");
}

const sourceRevision = (await runChecked("git", ["rev-parse", "HEAD"], repositoryRoot,
  { deadlineMs: 15_000 })).stdout.trim();
const status = (await runChecked("git", ["status", "--porcelain=v1", "--untracked-files=all"],
  repositoryRoot, { deadlineMs: 15_000 })).stdout;
const changedPaths = status.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3));
validateRequestedRevision("SURFACELOOM_HOST_REVISION", sourceRevision, changedPaths);
validateRequestedRevision("SURFACELOOM_FIXTURE_REVISION", sourceRevision, changedPaths);
const dotnetVersion = (await runChecked("dotnet", ["--version"], repositoryRoot,
  { deadlineMs: 15_000 })).stdout.trim();

const events = [];
let gate;
let gateReleased = false;
let contender;
try {
  gate = await acquireWindowsExecutionGuiGate({ userSid, sessionId, desktop,
    timeoutMs: 30_000, retryIntervalMs: 25 });
  recordGateEvent(events, "ownerAcquired");
  contender = new JsonLineChild(process.execPath,
    [fileURLToPath(import.meta.url), "--contender"], repositoryRoot);
  requireFrame(await contender.next(5_000), "waiting");
  recordGateEvent(events, "contenderWaiting");
  await assertStillWaiting(contender);

  const releaseState = { started: false };
  const successorObservation = observeSuccessorAcquisition(contender, events, releaseState, 240_000);
  const overlapGuard = guardAgainstOwnerOverlap(successorObservation);

  await Promise.race([runChecked("dotnet",
    ["run", "--project", liveProject, "-c", "Release", "--no-build", "--",
      hostExe, fixtureExe, reportPath], repositoryRoot, { deadlineMs: 180_000 }), overlapGuard]);
  const report = JSON.parse(await Promise.race([readFile(reportPath, "utf8"), overlapGuard]));
  validateLiveReport(report);
  recordGateEvent(events, "cleanupConfirmed");

  releaseState.started = true;
  const release = await gate.release();
  if (release.status !== "released") throw new Error("GUI execution gate release was not confirmed.");
  gateReleased = true;
  recordGateEvent(events, "ownerReleased");
  const successor = await successorObservation;
  if (successor.enteredBeforeRelease) {
    throw new Error("Contender acquired while the live GUI owner was still active.");
  }
  contender.send("release");
  requireFrame(await contender.next(5_000), "released");
  recordGateEvent(events, "successorReleased");
  await contender.expectExit(0);

  const metrics = deriveGateConcurrency(events);
  if (metrics.maxConcurrentGuiOwners !== 1 || !metrics.successorEnteredOnlyAfterCleanupAndRelease) {
    throw new Error("Observed GUI-gate event order did not prove serialized ownership.");
  }
  const relativeEvidence = path.relative(repositoryRoot, evidencePath).replaceAll(path.sep, "/");
  const evidence = { schemaVersion: "surfaceloom.sl-p2-080-windows-evidence/1",
    generatedAt: new Date().toISOString(), taskId: "SL-P2-080", sourceRevision,
    sourceDirty: changedPaths.length > 0, changedPaths,
    command: "native/windows-fixture/scripts/live-conformance.ps1", exitCode: 0,
    platform: { os: `${os.type()} ${os.release()}`, architecture: os.arch(), node: process.version,
      dotnet: dotnetVersion, sessionId, desktop }, executedTests: contractTests + report.executedCaseCount,
    skippedTests: 0, evidencePath: relativeEvidence, liveEvents: events,
    maxConcurrentGuiOwners: metrics.maxConcurrentGuiOwners,
    successorEnteredOnlyAfterCleanupAndRelease: metrics.successorEnteredOnlyAfterCleanupAndRelease,
    unconfirmedCleanupBlockedSuccessor,
    limitations: ["Does not implement or prove SL-P3-060 real Node-to-UIA execution.",
      "Does not implement or prove SL-P3-070 business mixed-surface behavior.",
      "File-system checks narrow known races and do not eliminate hostile-filesystem TOCTOU in general."],
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(`SL-P2-080 Windows evidence: ${relativeEvidence}`);
} catch (error) {
  if (gate !== undefined && !gateReleased) {
    await gate.quarantine("Windows live execution did not produce complete cleanup proof.").catch(() => undefined);
  }
  if (contender !== undefined && events.some((event) => event.type === "successorAcquired")) {
    contender.send("quarantine");
  }
  if (contender !== undefined) {
    try { await contender.expectExit(1); }
    catch { contender.containUnconfirmed(); await contender.expectExit(null).catch(() => undefined); }
  }
  throw error;
}

async function contenderMain() {
  if (process.platform !== "win32") throw new Error("GUI gate contender requires Windows.");
  const { acquireWindowsExecutionGuiGate } = await import(testEntry);
  const options = { userSid: requiredEnvironment("SURFACELOOM_WINDOWS_USER_SID"),
    sessionId: integerEnvironment("SURFACELOOM_WINDOWS_SESSION_ID"),
    desktop: requiredEnvironment("SURFACELOOM_WINDOWS_DESKTOP"), timeoutMs: 60_000,
    retryIntervalMs: 25 };
  process.stdout.write(`${JSON.stringify({ type: "waiting" })}\n`);
  const acquired = await acquireWindowsExecutionGuiGate(options);
  process.stdout.write(`${JSON.stringify({ type: "acquired", id: acquired.id })}\n`);
  let buffered = "";
  for await (const chunk of process.stdin.setEncoding("utf8")) {
    buffered += String(chunk);
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const command = buffered.slice(0, index).replace(/\r$/u, "");
      buffered = buffered.slice(index + 1);
      if (command === "release") {
        const receipt = await acquired.release();
        if (receipt.status !== "released") throw new Error("Contender release was not confirmed.");
        process.stdout.write(`${JSON.stringify({ type: "released" })}\n`);
        return;
      }
      if (command === "quarantine") {
        await acquired.quarantine("Contender parent could not confirm the live sequence.");
        throw new Error("Contender retained quarantine after a parent failure.");
      }
    }
  }
  await acquired.quarantine("Contender command channel closed before release.");
  throw new Error("Contender stdin closed before release.");
}

async function assertStillWaiting(child) {
  try { await child.next(150); }
  catch (error) { if (/protocol timed out/u.test(String(error))) return; throw error; }
  throw new Error("Contender acquired before the owner released the GUI gate.");
}

function validateLiveReport(report) {
  if (report.executedCaseCount !== 5 || report.passedCaseCount !== 5 || report.skippedCaseCount !== 0
      || report.cleanupConfirmed !== true || report.failure !== null) {
    throw new Error("C# live report lacks five-case success and post-cleanup proof.");
  }
  if (report.hostRevision !== requiredEnvironment("SURFACELOOM_HOST_REVISION")
      || report.fixtureRevision !== requiredEnvironment("SURFACELOOM_FIXTURE_REVISION")) {
    throw new Error("C# live report revision labels do not match the requested run.");
  }
}

function requireFrame(frame, type) {
  if (typeof frame !== "object" || frame === null || frame.type !== type) {
    throw new Error(`Contender protocol expected ${type}.`);
  }
}
function tapCount(source, label) {
  const match = new RegExp(`^# ${label} (\\d+)$`, "mu").exec(source);
  if (match === null) throw new Error(`TAP output omitted ${label} count.`);
  return Number(match[1]);
}
function validateRequestedRevision(name, actual, changedPaths) {
  const requested = requiredEnvironment(name);
  if (requested !== "working-tree" && (requested !== actual || changedPaths.length > 0)) {
    throw new Error(`${name} does not match the checked-out source revision.`);
  }
}
function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}
function integerEnvironment(name) {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}
