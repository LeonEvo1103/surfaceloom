$payload = Join-Path $temporaryRoot "payload"
[IO.Directory]::CreateDirectory((Join-Path $payload "nested")) | Out-Null
Write-ArtifactUtf8NoBom -Path (Join-Path $payload "one.bin") -Value "one"
Write-ArtifactUtf8NoBom -Path (Join-Path $payload "nested\two.bin") -Value "two"
Write-ArtifactUtf8NoBom -Path (Join-Path $payload "zero.bin") -Value ""
$records = Get-ArtifactTreeRecords -Root $payload
Assert-ArtifactRecords -Root $payload -Records $records -RequireExactFileSet
$fractionalRecords = @($records | ForEach-Object {
        [PSCustomObject]@{ path = $_.path; length = $_.length; sha256 = $_.sha256 }
    })
$fractionalRecords[0].length = 0.4
Expect-ArtifactFailure -MessagePattern 'integral length' -Action {
    Assert-ArtifactRecords -Root $payload -Records $fractionalRecords -RequireExactFileSet
}
if ((Test-ArtifactIntegralValue -Value "1") -or
    (Test-ArtifactIntegralValue -Value 0.4) -or
    -not (Test-ArtifactIntegralValue -Value ([int64]1))) {
    throw "Artifact integral metadata type validation is not strict."
}
Write-ArtifactUtf8NoBom -Path (Join-Path $payload "one.bin") -Value "tampered"
Expect-ArtifactFailure -MessagePattern 'does not match its record' -Action {
    Assert-ArtifactRecords -Root $payload -Records $records -RequireExactFileSet
}
Write-Host "PASS payload hash changes invalidate the manifest"
$passCount++

Write-ArtifactUtf8NoBom -Path (Join-Path $payload "one.bin") -Value "one"
Write-ArtifactUtf8NoBom -Path (Join-Path $payload "extra.bin") -Value "extra"
Expect-ArtifactFailure -MessagePattern 'does not exactly match' -Action {
    Assert-ArtifactRecords -Root $payload -Records $records -RequireExactFileSet
}
Remove-Item -LiteralPath (Join-Path $payload "extra.bin") -Force
Remove-Item -LiteralPath (Join-Path $payload "nested\two.bin") -Force
Remove-Item -LiteralPath (Join-Path $payload "nested") -Force
Expect-ArtifactFailure -MessagePattern 'missing|does not exactly match' -Action {
    Assert-ArtifactRecords -Root $payload -Records $records -RequireExactFileSet
}
Write-Host "PASS manifest verification rejects added and missing files"
$passCount++

Expect-ArtifactFailure -MessagePattern 'unsafe relative path' -Action {
    Assert-ArtifactSafeRelativePath -Path "..\escape.dll"
}
Expect-ArtifactFailure -MessagePattern 'unsafe relative path' -Action {
    Assert-ArtifactSafeRelativePath -Path "C:\absolute.dll"
}
Write-Host "PASS artifact records reject unsafe paths"
$passCount++

$emptyDirectory = Join-Path $payload "empty-directory"
[IO.Directory]::CreateDirectory($emptyDirectory) | Out-Null
Expect-ArtifactFailure -MessagePattern 'unrecorded empty directory' -Action {
    Get-ArtifactTreeRecords -Root $payload
}
Remove-Item -LiteralPath $emptyDirectory -Force
Write-Host "PASS exact artifact trees reject unrecorded empty directories"
$passCount++

[IO.Directory]::CreateDirectory((Join-Path $payload "nested")) | Out-Null
Write-ArtifactUtf8NoBom -Path (Join-Path $payload "nested\two.bin") -Value "two"
$unicodePayloadName = ([char]0x8BF4).ToString() +
    ([char]0x660E).ToString() + ".bin"
Write-ArtifactUtf8NoBom `
    -Path (Join-Path $payload $unicodePayloadName) `
    -Value "unicode-name"
$sumsPath = Join-Path $payload "SHA256SUMS.txt"
Write-ArtifactSha256Sums -Root $payload -Path $sumsPath
Assert-ArtifactSha256Sums -Root $payload -Path $sumsPath
$validSums = Read-ArtifactUtf8Strict -Path $sumsPath
$replacement = if ($validSums[0] -eq '0') { '1' } else { '0' }
Write-ArtifactUtf8NoBom `
    -Path $sumsPath `
    -Value ($replacement + $validSums.Substring(1))
Expect-ArtifactFailure -MessagePattern 'SHA256SUMS does not match artifact' -Action {
    Assert-ArtifactSha256Sums -Root $payload -Path $sumsPath
}
Write-ArtifactUtf8NoBom -Path $sumsPath -Value $validSums
Write-ArtifactUtf8NoBom -Path (Join-Path $payload "unlisted.bin") -Value "unlisted"
Expect-ArtifactFailure -MessagePattern 'does not exactly match' -Action {
    Assert-ArtifactSha256Sums -Root $payload -Path $sumsPath
}
Remove-Item -LiteralPath (Join-Path $payload "unlisted.bin") -Force
Assert-ArtifactSha256Sums -Root $payload -Path $sumsPath
Write-Host "PASS SHA256SUMS is strict UTF-8 and closes over the exact artifact tree"
$passCount++
