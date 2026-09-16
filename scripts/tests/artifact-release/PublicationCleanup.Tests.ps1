$publishParent = Join-Path $temporaryRoot "publish"
$staging = Join-Path $publishParent ".release.partial"
$final = Join-Path $publishParent "release"
[IO.Directory]::CreateDirectory($staging) | Out-Null
Write-ArtifactUtf8NoBom -Path (Join-Path $staging "artifact.zip") -Value "zip"
Move-ArtifactDirectoryAtomically `
    -StagingDirectory ($staging + [IO.Path]::DirectorySeparatorChar) `
    -FinalDirectory ($final + [IO.Path]::DirectorySeparatorChar)
if (-not (Test-Path -LiteralPath (Join-Path $final "artifact.zip") -PathType Leaf)) {
    throw "Atomic artifact publication did not expose the complete directory."
}
$secondStaging = Join-Path $publishParent ".release-second.partial"
[IO.Directory]::CreateDirectory($secondStaging) | Out-Null
Expect-ArtifactFailure -MessagePattern 'already exists' -Action {
    Move-ArtifactDirectoryAtomically -StagingDirectory $secondStaging -FinalDirectory $final
}
if (-not (Test-Path -LiteralPath $secondStaging -PathType Container)) {
    throw "A rejected atomic publish must preserve its staging directory for caller cleanup."
}
Write-Host "PASS atomic publication never replaces an existing release"
$passCount++

$cleanupParent = Join-Path $temporaryRoot "cleanup"
[IO.Directory]::CreateDirectory($cleanupParent) | Out-Null
$cleanupLeaf = "surfaceloom-clean-{0}" -f [Guid]::NewGuid().ToString("N")
$cleanupDirectory = Join-Path $cleanupParent $cleanupLeaf
[IO.Directory]::CreateDirectory($cleanupDirectory) | Out-Null
Write-ArtifactUtf8NoBom -Path (Join-Path $cleanupDirectory "owned.tmp") -Value "owned"
Expect-ArtifactFailure -MessagePattern 'outside its declared scope' -Action {
    Remove-ArtifactDirectorySafely `
        -Directory $cleanupDirectory `
        -ExpectedParent $cleanupParent `
        -ExpectedLeafPattern '^wrong-prefix-'
}
if (-not (Test-Path -LiteralPath $cleanupDirectory -PathType Container)) {
    throw "Rejected safe cleanup must preserve its target."
}
Remove-ArtifactDirectorySafely `
    -Directory $cleanupDirectory `
    -ExpectedParent $cleanupParent `
    -ExpectedLeafPattern '^surfaceloom-clean-[0-9a-f]{32}$'
if (Test-Path -LiteralPath $cleanupDirectory) {
    throw "Safe cleanup did not remove its exact owned directory."
}
Write-Host "PASS safe cleanup is scoped by exact parent, leaf pattern, and tree validation"
$passCount++
