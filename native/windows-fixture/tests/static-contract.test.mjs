import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
