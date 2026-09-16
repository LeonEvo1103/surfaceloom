Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "lib\ArtifactRelease.psm1") -Force
$contractRepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Expect-ArtifactFailure {
    param(
        [Parameter(Mandatory = $true)] [scriptblock]$Action,
        [Parameter(Mandatory = $true)] [string]$MessagePattern
    )

    try {
        & $Action
    }
    catch {
        if ($_.Exception.Message -notmatch $MessagePattern) {
            throw "Artifact contract failed for an unexpected reason: $($_.Exception.Message)"
        }
        return
    }
    throw "Expected artifact release contract to fail closed."
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "surfaceloom-artifact-contract-{0}" -f [Guid]::NewGuid().ToString("N"))
$passCount = 0
$contractRoot = Join-Path $PSScriptRoot "tests\artifact-release"
$contractFiles = @(
    "MetadataSnapshot.Tests.ps1",
    "ManifestHash.Tests.ps1",
    "CanonicalArchive.Tests.ps1",
    "PublicationCleanup.Tests.ps1") | ForEach-Object { Join-Path $contractRoot $_ }
$artifactModuleRoot = Join-Path $PSScriptRoot "lib\ArtifactRelease"
$artifactModuleFiles = @(
    (Join-Path $PSScriptRoot "lib\ArtifactRelease.psm1"),
    (Join-Path $artifactModuleRoot "ArtifactPath.ps1"),
    (Join-Path $artifactModuleRoot "ArtifactDirectories.ps1"),
    (Join-Path $artifactModuleRoot "ArtifactRecords.ps1"),
    (Join-Path $artifactModuleRoot "ArtifactArchive.ps1"),
    (Join-Path $artifactModuleRoot "ArtifactSnapshot.ps1"))

foreach ($sourceFile in @($artifactModuleFiles + $contractFiles)) {
    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile(
        $sourceFile, [ref]$tokens, [ref]$errors)
    if (@($errors).Count -ne 0) {
        throw "An artifact release source or contract file has a PowerShell parse error."
    }
    if ([IO.File]::ReadAllLines($sourceFile).Count -gt 250) {
        throw "An artifact release source or contract file exceeds 250 lines."
    }
}

try {
    [IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
    foreach ($contractFile in $contractFiles) {
        . $contractFile
    }
    Write-Host "ARTIFACT_RELEASE_CONTRACTS=$passCount/14"
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Force -Recurse
    }
}
