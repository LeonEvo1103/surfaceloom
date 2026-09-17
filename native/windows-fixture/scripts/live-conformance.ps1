param(
    [string]$HostRevision = "working-tree",
    [string]$FixtureRevision = "working-tree"
)

$ErrorActionPreference = "Stop"

$fixtureRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Split-Path -Parent $fixtureRoot
$hostRoot = Join-Path $nativeRoot "windows-host"
$hostProject = Join-Path $hostRoot "src/SurfaceLoom.WindowsHost/SurfaceLoom.WindowsHost.csproj"
$fixtureProject = Join-Path $fixtureRoot "src/SurfaceLoom.WindowsFixture/SurfaceLoom.WindowsFixture.csproj"
$liveProject = Join-Path $fixtureRoot "tests/SurfaceLoom.WindowsFixture.LiveTests/SurfaceLoom.WindowsFixture.LiveTests.csproj"
$hostExe = Join-Path $hostRoot "src/SurfaceLoom.WindowsHost/bin/Release/net8.0-windows10.0.19041.0/SurfaceLoom.WindowsHost.exe"
$fixtureExe = Join-Path $fixtureRoot "src/SurfaceLoom.WindowsFixture/bin/Release/net8.0-windows/SurfaceLoom.WindowsFixture.exe"
$report = Join-Path $fixtureRoot "artifacts/windows-live-conformance.json"

$env:SURFACELOOM_HOST_REVISION = $HostRevision
$env:SURFACELOOM_FIXTURE_REVISION = $FixtureRevision

dotnet build $hostProject -c Release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet build $fixtureProject -c Release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project $liveProject -c Release -- $hostExe $fixtureExe $report
exit $LASTEXITCODE
