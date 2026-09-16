$repository = Join-Path $temporaryRoot "repository"
$sourceRoot = Join-Path $repository "product"
$exactRoot = Join-Path $repository "scripts"
[IO.Directory]::CreateDirectory($sourceRoot) | Out-Null
[IO.Directory]::CreateDirectory($exactRoot) | Out-Null
Write-ArtifactUtf8NoBom -Path (Join-Path $sourceRoot "one.cs") -Value "first"
Write-ArtifactUtf8NoBom -Path (Join-Path $sourceRoot "ignored.txt") -Value "ignored"
$exactFile = Join-Path $exactRoot "release.ps1"
Write-ArtifactUtf8NoBom -Path $exactFile -Value "release"

$jsonObjectPath = Join-Path $temporaryRoot "metadata.json"
Write-ArtifactUtf8NoBom `
    -Path $jsonObjectPath `
    -Value '{"kind":"release","shape":["sample"]}'
$jsonObject = Read-ArtifactJsonObjectStrict -Path $jsonObjectPath
$shapeValue = Get-ArtifactRequiredPropertyValue -Object $jsonObject -Name "shape"
if (-not ($shapeValue -is [object[]]) -or $shapeValue.Count -ne 1 -or
    $shapeValue[0] -cne "sample") {
    throw "Strict artifact JSON must preserve an array-valued property."
}
Write-ArtifactUtf8NoBom `
    -Path $jsonObjectPath `
    -Value '[{"kind":"release"}]'
Expect-ArtifactFailure -MessagePattern 'top-level JSON object' -Action {
    Read-ArtifactJsonObjectStrict -Path $jsonObjectPath
}
Write-ArtifactUtf8NoBom -Path $jsonObjectPath -Value '"release"'
Expect-ArtifactFailure -MessagePattern 'top-level JSON object' -Action {
    Read-ArtifactJsonObjectStrict -Path $jsonObjectPath
}
Write-Host "PASS structured metadata requires one JSON object and preserves array shape"
$passCount++

$before = Get-ArtifactSourceSnapshot `
    -RepositoryRoot $repository `
    -SourceRoots $sourceRoot `
    -ExactFiles $exactFile `
    -AllowedExtensions ".cs"
$copy = Join-Path $temporaryRoot "source-copy"
Copy-ArtifactSourceSnapshot `
    -RepositoryRoot $repository `
    -Snapshot $before `
    -DestinationRoot $copy
if ($before.files.Count -ne 2) {
    throw "Source snapshot must contain only the declared tree inputs and exact files."
}
Write-Host "PASS source snapshots copy an exact content-addressed input tree"
$passCount++

$allInputRoot = Join-Path $repository "all-inputs"
[IO.Directory]::CreateDirectory($allInputRoot) | Out-Null
Write-ArtifactUtf8NoBom -Path (Join-Path $allInputRoot "view.xaml") -Value "<Window />"
Write-ArtifactUtf8NoBom -Path (Join-Path $allInputRoot "app.config") -Value "<configuration />"
Write-ArtifactUtf8NoBom -Path (Join-Path $allInputRoot "signing.snk") -Value "fixture"
Write-ArtifactUtf8NoBom -Path (Join-Path $allInputRoot "empty.generated") -Value ""
$allInputs = Get-ArtifactSourceSnapshot `
    -RepositoryRoot $repository `
    -SourceRoots $allInputRoot
if ($allInputs.files.Count -ne 4 -or
    @($allInputs.files | Where-Object { $_.path -eq "all-inputs/empty.generated" }).Count -ne 1) {
    throw "Default source snapshots must include non-C# and zero-byte build inputs."
}
Write-Host "PASS default source snapshots include every declared-root file extension"
$passCount++

Write-ArtifactUtf8NoBom -Path (Join-Path $sourceRoot "one.cs") -Value "second"
$after = Get-ArtifactSourceSnapshot `
    -RepositoryRoot $repository `
    -SourceRoots $sourceRoot `
    -ExactFiles $exactFile `
    -AllowedExtensions ".cs"
Expect-ArtifactFailure -MessagePattern 'Artifact sources changed' -Action {
    Assert-ArtifactSourceSnapshotUnchanged -Before $before -After $after
}
Write-ArtifactUtf8NoBom -Path (Join-Path $sourceRoot "one.cs") -Value "first"
[IO.File]::SetLastWriteTimeUtc(
    (Join-Path $sourceRoot "one.cs"),
    $before.latestWriteTimeUtc.AddMinutes(2))
$touched = Get-ArtifactSourceSnapshot `
    -RepositoryRoot $repository `
    -SourceRoots $sourceRoot `
    -ExactFiles $exactFile `
    -AllowedExtensions ".cs"
Expect-ArtifactFailure -MessagePattern 'Artifact sources changed' -Action {
    Assert-ArtifactSourceSnapshotUnchanged -Before $before -After $touched
}
Write-Host "PASS source content changes and timestamp-only touches invalidate release freshness"
$passCount++

$freshnessPayload = Join-Path $temporaryRoot "freshness.dll"
Write-ArtifactUtf8NoBom -Path $freshnessPayload -Value "payload"
[IO.File]::SetLastWriteTimeUtc(
    $freshnessPayload,
    $before.latestWriteTimeUtc.AddMinutes(-1))
Expect-ArtifactFailure -MessagePattern 'Release payload is older' -Action {
    Assert-ArtifactPayloadFreshness `
        -SourceSnapshot $before `
        -PayloadPaths $freshnessPayload `
        -BuildStartedUtc ([DateTime]::UtcNow.AddMinutes(-1)) `
        -TimestampToleranceSeconds 0
}
$freshBuildStart = [DateTime]::UtcNow.AddSeconds(-1)
[IO.File]::SetLastWriteTimeUtc($freshnessPayload, [DateTime]::UtcNow)
Assert-ArtifactPayloadFreshness `
    -SourceSnapshot $before `
    -PayloadPaths $freshnessPayload `
    -BuildStartedUtc $freshBuildStart `
    -TimestampToleranceSeconds 0
Write-Host "PASS payload timestamps must be newer than the build and source snapshot"
$passCount++
