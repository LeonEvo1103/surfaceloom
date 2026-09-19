param(
    [string]$HostRevision = "working-tree",
    [string]$FixtureRevision = "working-tree"
)

$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile(
    $PSCommandPath, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw "PowerShell AST validation failed for the live-conformance entrypoint."
}
$fixtureRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Split-Path -Parent $fixtureRoot
$repositoryRoot = Split-Path -Parent $nativeRoot
$hostRoot = Join-Path $nativeRoot "windows-host"
$hostProject = Join-Path $hostRoot "src/SurfaceLoom.WindowsHost/SurfaceLoom.WindowsHost.csproj"
$fixtureProject = Join-Path $fixtureRoot "src/SurfaceLoom.WindowsFixture/SurfaceLoom.WindowsFixture.csproj"
$liveProject = Join-Path $fixtureRoot "tests/SurfaceLoom.WindowsFixture.LiveTests/SurfaceLoom.WindowsFixture.LiveTests.csproj"
$hostExe = Join-Path $hostRoot "src/SurfaceLoom.WindowsHost/bin/Release/net8.0-windows10.0.19041.0/SurfaceLoom.WindowsHost.exe"
$fixtureExe = Join-Path $fixtureRoot "src/SurfaceLoom.WindowsFixture/bin/Release/net8.0-windows/SurfaceLoom.WindowsFixture.exe"
$report = Join-Path $fixtureRoot "artifacts/windows-live-conformance.json"
$evidence = Join-Path $fixtureRoot "artifacts/sl-p2-080-windows-evidence.json"
$gateRunner = Join-Path $PSScriptRoot "run-live-with-gate.mjs"

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory)
    Push-Location $WorkingDirectory
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $Command"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not ("SurfaceLoomDesktopProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SurfaceLoomDesktopProbe {
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint id);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    public static string Current() {
        var desktop = GetThreadDesktop(GetCurrentThreadId());
        var needed = 0;
        GetUserObjectInformation(desktop, 2, null, 0, out needed);
        var value = new StringBuilder(Math.Max(needed / 2, 16));
        if (!GetUserObjectInformation(desktop, 2, value, value.Capacity * 2, out needed)) {
            throw new InvalidOperationException("Cannot inspect the current Windows desktop.");
        }
        return value.ToString();
    }
}
"@
}

$desktop = [SurfaceLoomDesktopProbe]::Current()
if ($desktop -cne "Default") {
    throw "Windows live conformance requires the unlocked default desktop; current desktop is not Default."
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($null -eq $identity.User) { throw "Cannot resolve the current Windows user SID." }

foreach ($package in @("core", "reporter", "test")) {
    $packageRoot = Join-Path $repositoryRoot "packages/$package"
    Invoke-Checked "npm.cmd" @("ci", "--ignore-scripts") $packageRoot
    Invoke-Checked "npm.cmd" @("run", "build") $packageRoot
}

Invoke-Checked "dotnet" @("build", $hostProject, "-c", "Release") $repositoryRoot
Invoke-Checked "dotnet" @("build", $fixtureProject, "-c", "Release") $repositoryRoot
Invoke-Checked "dotnet" @("build", $liveProject, "-c", "Release") $repositoryRoot

$env:SURFACELOOM_HOST_REVISION = $HostRevision
$env:SURFACELOOM_FIXTURE_REVISION = $FixtureRevision
$env:SURFACELOOM_WINDOWS_USER_SID = $identity.User.Value
$env:SURFACELOOM_WINDOWS_SESSION_ID = [Diagnostics.Process]::GetCurrentProcess().SessionId.ToString()
$env:SURFACELOOM_WINDOWS_DESKTOP = "default"

Invoke-Checked "node.exe" @($gateRunner, $hostExe, $fixtureExe, $report, $evidence, $liveProject) $repositoryRoot
