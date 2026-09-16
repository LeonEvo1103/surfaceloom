Set-StrictMode -Version Latest

$privateRoot = Join-Path $PSScriptRoot "ArtifactRelease"
$privateDirectory = Get-Item -LiteralPath $privateRoot -Force -ErrorAction Stop
if (-not $privateDirectory.PSIsContainer -or
    ($privateDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "ArtifactRelease private source root must be an ordinary directory."
}
$privateScripts = @(
    "ArtifactPath.ps1",
    "ArtifactDirectories.ps1",
    "ArtifactRecords.ps1",
    "ArtifactArchive.ps1",
    "ArtifactSnapshot.ps1")
foreach ($privateScript in $privateScripts) {
    $privatePath = Join-Path $privateRoot $privateScript
    $privateItem = Get-Item -LiteralPath $privatePath -Force -ErrorAction Stop
    if ($privateItem.PSIsContainer -or
        ($privateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $privateItem.Length -le 0) {
        throw "ArtifactRelease private source must be a non-empty ordinary file."
    }
    . $privatePath
}

Export-ModuleMember -Function @(
    "Get-ArtifactLowerSha256",
    "Test-ArtifactIntegralValue",
    "Get-ArtifactRequiredPropertyValue",
    "Assert-ArtifactOrdinaryFile",
    "Write-ArtifactUtf8NoBom",
    "Read-ArtifactUtf8Strict",
    "Read-ArtifactJsonObjectStrict",
    "Get-ArtifactCanonicalDirectoryPath",
    "Get-ArtifactRelativePath",
    "Assert-ArtifactSafeRelativePath",
    "Assert-ArtifactPathChainNoReparse",
    "Get-ArtifactSourceSnapshot",
    "Assert-ArtifactSourceSnapshotUnchanged",
    "Assert-ArtifactPayloadFreshness",
    "Copy-ArtifactSourceSnapshot",
    "Get-ArtifactTreeRecords",
    "Assert-ArtifactRecords",
    "Write-ArtifactSha256Sums",
    "Assert-ArtifactSha256Sums",
    "New-ArtifactCanonicalZip",
    "Assert-ArtifactDirectoryTreeNoReparse",
    "Assert-ArtifactTreeHasNoEmptyDirectories",
    "Remove-ArtifactEmptyDirectories",
    "Remove-ArtifactDirectorySafely",
    "Move-ArtifactDirectoryAtomically"
)
