$archivePayload = Join-Path $temporaryRoot "archive-payload"
$archiveNested = Join-Path $archivePayload "nested"
[IO.Directory]::CreateDirectory($archiveNested) | Out-Null
Write-ArtifactUtf8NoBom `
    -Path (Join-Path $archivePayload "root.txt") `
    -Value "root"
$unicodeLeaf = ([char]0x8BF4).ToString() + ([char]0x660E).ToString() + ".txt"
Write-ArtifactUtf8NoBom `
    -Path (Join-Path $archiveNested $unicodeLeaf) `
    -Value "nested"
$canonicalZip = Join-Path $temporaryRoot "canonical.zip"
New-ArtifactCanonicalZip -Root $archivePayload -Path $canonicalZip

Add-Type -AssemblyName System.IO.Compression.FileSystem
$canonicalArchive = [IO.Compression.ZipFile]::OpenRead($canonicalZip)
try {
    $canonicalNames = @($canonicalArchive.Entries | ForEach-Object { $_.FullName })
    if ($canonicalNames.Count -ne 2 -or
        @($canonicalNames | Where-Object { $_.Contains('\') }).Count -ne 0 -or
        @($canonicalNames | Where-Object { $_ -ceq "root.txt" }).Count -ne 1 -or
        @($canonicalNames | Where-Object { $_ -ceq "nested/$unicodeLeaf" }).Count -ne 1) {
        throw "Canonical ZIP entries must use exact forward-slash payload paths."
    }
}
finally { $canonicalArchive.Dispose() }
Write-Host "PASS canonical ZIP writing is independent of host path-separator quirks"
$passCount++

Expect-ArtifactFailure -MessagePattern 'must not already exist' -Action {
    New-ArtifactCanonicalZip -Root $archivePayload -Path $canonicalZip
}
Expect-ArtifactFailure -MessagePattern 'outside its payload root' -Action {
    New-ArtifactCanonicalZip `
        -Root $archivePayload `
        -Path (Join-Path $archivePayload "inside.zip")
}
Write-Host "PASS canonical ZIP creation refuses overwrite and recursive self-inclusion"
$passCount++
