function Get-ArtifactSourceSnapshot {
    param(
        [Parameter(Mandatory = $true)] [string]$RepositoryRoot,
        [Parameter(Mandatory = $true)] [string[]]$SourceRoots,
        [string[]]$ExactFiles = @(),
        [string[]]$AllowedExtensions = @(),
        [string[]]$ExcludedDirectoryNames = @("bin", "obj", ".git", ".vs")
    )

    $root = [IO.Path]::GetFullPath($RepositoryRoot)
    $filesByPath = [Collections.Generic.Dictionary[string, IO.FileInfo]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    foreach ($sourceRootValue in $SourceRoots) {
        $sourceRoot = [IO.Path]::GetFullPath($sourceRootValue)
        Assert-ArtifactPathChainNoReparse -Root $root -Path $sourceRoot
        if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
            throw "Artifact source root is missing: $sourceRoot"
        }
        $null = Assert-ArtifactDirectoryTreeNoReparse -Path $sourceRoot
        Assert-ArtifactTreeHasNoEmptyDirectories `
            -Path $sourceRoot `
            -ExcludedDirectoryNames $ExcludedDirectoryNames
        foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -File -Force -Recurse) {
            $relative = Get-ArtifactRelativePath -Root $root -Path $file.FullName
            $segments = @($relative.Split('/'))
            if (@($segments | Where-Object { $ExcludedDirectoryNames -contains $_ }).Count -gt 0) {
                continue
            }
            if ($AllowedExtensions.Count -gt 0 -and
                $AllowedExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
            $ordinary = Assert-ArtifactOrdinaryFile `
                -Path $file.FullName `
                -Description "artifact source" `
                -AllowEmpty
            $filesByPath[$relative] = $ordinary
        }
    }
    foreach ($exactFileValue in $ExactFiles) {
        $exactFile = [IO.Path]::GetFullPath($exactFileValue)
        Assert-ArtifactPathChainNoReparse -Root $root -Path $exactFile
        $relative = Get-ArtifactRelativePath -Root $root -Path $exactFile
        $filesByPath[$relative] = Assert-ArtifactOrdinaryFile `
            -Path $exactFile `
            -Description "exact artifact source" `
            -AllowEmpty
    }

    $entries = @($filesByPath.GetEnumerator() |
        Sort-Object Key |
        ForEach-Object {
            [PSCustomObject][ordered]@{
                path = $_.Key
                length = [long]$_.Value.Length
                lastWriteTimeUtc = $_.Value.LastWriteTimeUtc.ToString(
                    "O", [Globalization.CultureInfo]::InvariantCulture)
                sha256 = Get-ArtifactLowerSha256 -Path $_.Value.FullName
            }
        })
    if ($entries.Count -eq 0) { throw "The artifact source snapshot is empty." }

    $canonical = ($entries | ForEach-Object {
            "{0}`t{1}`t{2}" -f $_.path, $_.length, $_.sha256
        }) -join "`n"
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($canonical)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
    $latest = ($filesByPath.Values |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1).LastWriteTimeUtc
    [PSCustomObject][ordered]@{
        digest = $digest
        latestWriteTimeUtc = $latest
        files = $entries
    }
}

function Assert-ArtifactSourceSnapshotUnchanged {
    param(
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$After
    )

    $beforeState = ($Before.files | ForEach-Object {
            "{0}`t{1}`t{2}`t{3}" -f $_.path, $_.length, $_.sha256, $_.lastWriteTimeUtc
        }) -join "`n"
    $afterState = ($After.files | ForEach-Object {
            "{0}`t{1}`t{2}`t{3}" -f $_.path, $_.length, $_.sha256, $_.lastWriteTimeUtc
        }) -join "`n"
    if (-not [string]::Equals($Before.digest, $After.digest, [StringComparison]::Ordinal) -or
        $Before.files.Count -ne $After.files.Count -or
        -not [string]::Equals($beforeState, $afterState, [StringComparison]::Ordinal)) {
        throw "Artifact sources changed while the release was being built or verified."
    }
}

function Assert-ArtifactPayloadFreshness {
    param(
        [Parameter(Mandatory = $true)]$SourceSnapshot,
        [Parameter(Mandatory = $true)] [string[]]$PayloadPaths,
        [Parameter(Mandatory = $true)] [DateTime]$BuildStartedUtc,
        [ValidateRange(0, 60)] [int]$TimestampToleranceSeconds = 2
    )

    $oldestAllowedBuildTime = $BuildStartedUtc.ToUniversalTime().AddSeconds(
        -$TimestampToleranceSeconds)
    $oldestAllowedSourceTime = ([DateTime]$SourceSnapshot.latestWriteTimeUtc).ToUniversalTime().AddSeconds(
        -$TimestampToleranceSeconds)
    foreach ($payloadPath in $PayloadPaths) {
        $payload = Assert-ArtifactOrdinaryFile `
            -Path $payloadPath `
            -Description "fresh release payload"
        if ($payload.LastWriteTimeUtc -lt $oldestAllowedBuildTime -or
            $payload.LastWriteTimeUtc -lt $oldestAllowedSourceTime) {
            throw "Release payload is older than its build or source snapshot: $($payload.Name)"
        }
    }
}

function Copy-ArtifactSourceSnapshot {
    param(
        [Parameter(Mandatory = $true)] [string]$RepositoryRoot,
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)] [string]$DestinationRoot
    )

    $sourceRoot = [IO.Path]::GetFullPath($RepositoryRoot)
    $destination = [IO.Path]::GetFullPath($DestinationRoot)
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    foreach ($record in $Snapshot.files) {
        $relative = Assert-ArtifactSafeRelativePath -Path $record.path
        $source = Join-Path $sourceRoot $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $target = Join-Path $destination $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }
    Assert-ArtifactRecords -Root $destination -Records $Snapshot.files -RequireExactFileSet
}
