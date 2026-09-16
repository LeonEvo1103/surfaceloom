import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(await readFile(path.join(root, "fixture-contract.v1.json"), "utf8"));
const identitySource = await readFile(
  path.join(root, "Sources", "SurfaceLoomMacOSFixtureModel", "FixtureIdentity.swift"),
  "utf8",
);
const controllerSource = await readFile(
  path.join(root, "Sources", "SurfaceLoomMacOSFixtureApp", "FixtureWindowController.swift"),
  "utf8",
);

async function productionFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".build" || entry.name === ".swiftpm") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await productionFiles(entryPath)));
    else if ([".swift", ".json"].includes(path.extname(entry.name))) files.push(entryPath);
  }
  return files;
}

test("Swift identity registry exposes every normative AX identifier exactly once", () => {
  for (const element of [contract.root, ...contract.controls]) {
    const escaped = element.automationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = identitySource.match(new RegExp(`identifier: "${escaped}"`, "g")) ?? [];
    assert.equal(matches.length, 1, `${element.automationId} must occur once in FixtureIdentity.swift`);
    assert.ok(identitySource.includes(`name: "${element.name}"`));
  }
});

test("AppKit controller implements each mutating behavior", () => {
  for (const marker of [
    "state.recordInvoke()",
    "state.setValue(value)",
    "state.recordAmbiguousInvocation()",
    "state.dismissTransient()",
    "state.restoreTransient()",
    "state.beginClosing()",
  ]) {
    assert.ok(controllerSource.includes(marker), `missing state transition ${marker}`);
  }
});

test("AX value setting and keyboard editing share the mirror update path", async () => {
  const controlsSource = await readFile(
    path.join(root, "Sources", "SurfaceLoomMacOSFixtureApp", "AccessibleControls.swift"),
    "utf8",
  );
  assert.ok(controlsSource.includes("override func setAccessibilityValue"));
  assert.ok(controlsSource.includes("onAccessibilityValueChange?(value)"));
  assert.ok(controllerSource.includes("valueInputField.onAccessibilityValueChange"));
  assert.ok(controllerSource.includes("acceptInputValue(field.stringValue)"));
  assert.ok(controllerSource.includes("valueMirrorField.stringValue = value"));
});

test("transient control is removed from and restored to the real AppKit hierarchy", () => {
  assert.ok(controllerSource.includes("transientStack.removeArrangedSubview(transientButton)"));
  assert.ok(controllerSource.includes("transientButton.removeFromSuperview()"));
  assert.ok(controllerSource.includes("transientStack.insertArrangedSubview(transientButton, at: 0)"));
  assert.doesNotMatch(controllerSource, /transientButton\.isHidden\s*=/);
});

test("fixture sources have no network implementation, elevation, or company branding", async () => {
  const files = await productionFiles(path.join(root, "Sources"));
  const content = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(content, /URLSession|NWConnection|Network\.|CFNetwork|\bSocket\b/);
  assert.doesNotMatch(content, /AuthorizationExecuteWithPrivileges|SMJobBless|kTCCService/);
  assert.doesNotMatch(content, /EvoMap|EvoX|evomap|evox/);
});

test("package has no external dependencies", async () => {
  const manifest = await readFile(path.join(root, "Package.swift"), "utf8");
  assert.doesNotMatch(manifest, /\.package\s*\(/);
  assert.match(manifest, /platforms: \[\.macOS\(\.v13\)\]/);
});
