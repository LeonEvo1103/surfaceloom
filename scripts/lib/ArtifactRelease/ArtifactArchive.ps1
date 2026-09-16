function New-ArtifactCanonicalZip {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$Root,
        [Parameter(Mandatory = $true)] [string]$Path
    )

    $rootPath = Get-ArtifactCanonicalDirectoryPath -Path $Root
    $null = Assert-ArtifactDirectoryTreeNoReparse -Path $rootPath
    $archivePath = [IO.Path]::GetFullPath($Path)
    $rootPrefix = $rootPath.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ([string]::Equals($archivePath, $rootPath, [StringComparison]::OrdinalIgnoreCase) -or
        $archivePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "A canonical ZIP must be created outside its payload root."
    }
    if (Test-Path -LiteralPath $archivePath) {
        throw "A canonical ZIP destination must not already exist."
    }
    $archiveParent = [IO.Path]::GetDirectoryName($archivePath)
    if (-not $archiveParent) { throw "A canonical ZIP must have an existing parent." }
    $null = Assert-ArtifactDirectoryTreeNoReparse -Path $archiveParent

    $records = @(Get-ArtifactTreeRecords -Root $rootPath)
    $expected = [Collections.Generic.Dictionary[string, object]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $records) {
        $relative = Get-ArtifactRequiredPropertyValue -Object $record -Name "path"
        if (-not ($relative -is [string]) -or $relative.Contains('\') -or
            (Assert-ArtifactSafeRelativePath -Path $relative) -cne $relative -or
            $expected.ContainsKey($relative)) {
            throw "A canonical ZIP payload path is invalid or duplicated."
        }
        $expected.Add($relative, $record)
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stagingLeaf = ".{0}.partial-{1}" -f `
        [IO.Path]::GetFileName($archivePath), [Guid]::NewGuid().ToString("N")
    $stagingArchivePath = Join-Path $archiveParent $stagingLeaf
    $stagingOwned = $false
    $published = $false
    try {
        $archiveStream = [IO.FileStream]::new(
            $stagingArchivePath, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $stagingOwned = $true
        try {
            $archive = [IO.Compression.ZipArchive]::new(
                $archiveStream, [IO.Compression.ZipArchiveMode]::Create, $true)
            try {
                foreach ($record in $records) {
                    $relative = [string]$record.path
                    $sourcePath = Join-Path $rootPath (
                        $relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
                    $source = Assert-ArtifactOrdinaryFile `
                        -Path $sourcePath -Description "canonical ZIP payload" -AllowEmpty
                    if ($source.Length -ne [long]$record.length -or
                        (Get-ArtifactLowerSha256 -Path $source.FullName) -cne
                            [string]$record.sha256) {
                        throw "A canonical ZIP payload changed before it was archived."
                    }
                    $entry = $archive.CreateEntry(
                        $relative, [IO.Compression.CompressionLevel]::Optimal)
                    $sourceStream = [IO.FileStream]::new(
                        $source.FullName, [IO.FileMode]::Open,
                        [IO.FileAccess]::Read, [IO.FileShare]::Read)
                    try {
                        $entryStream = $entry.Open()
                        try { $sourceStream.CopyTo($entryStream) }
                        finally { $entryStream.Dispose() }
                    }
                    finally { $sourceStream.Dispose() }
                }
            }
            finally { $archive.Dispose() }
        }
        finally { $archiveStream.Dispose() }

        Assert-ArtifactRecords -Root $rootPath -Records $records -RequireExactFileSet
        $null = Assert-ArtifactOrdinaryFile `
            -Path $stagingArchivePath -Description "canonical ZIP"
        $verifiedNames = [Collections.Generic.HashSet[string]]::new(
            [StringComparer]::OrdinalIgnoreCase)
        $verifiedArchive = [IO.Compression.ZipFile]::OpenRead($stagingArchivePath)
        try {
            if ($verifiedArchive.Entries.Count -ne $records.Count) {
                throw "A canonical ZIP does not contain the exact payload entry count."
            }
            foreach ($entry in $verifiedArchive.Entries) {
                if ([string]::IsNullOrEmpty($entry.Name) -or
                    $entry.FullName.Contains('\') -or
                    -not $verifiedNames.Add($entry.FullName) -or
                    -not $expected.ContainsKey($entry.FullName)) {
                    throw "A canonical ZIP contains a non-canonical or unexpected entry."
                }
                $record = $expected[$entry.FullName]
                if ($entry.FullName -cne [string]$record.path -or
                    $entry.Length -ne [long]$record.length) {
                    throw "A canonical ZIP entry does not match its payload record."
                }
                $entryStream = $entry.Open()
                $sha256 = [Security.Cryptography.SHA256]::Create()
                try {
                    $actualHash = [BitConverter]::ToString(
                        $sha256.ComputeHash($entryStream)).Replace('-', '').ToLowerInvariant()
                }
                finally {
                    $sha256.Dispose()
                    $entryStream.Dispose()
                }
                if ($actualHash -cne [string]$record.sha256) {
                    throw "A canonical ZIP entry hash does not match its payload record."
                }
            }
        }
        finally { $verifiedArchive.Dispose() }

        [IO.File]::Move($stagingArchivePath, $archivePath)
        $stagingOwned = $false
        $published = $true
    }
    finally {
        if ($stagingOwned -and -not $published -and
            (Test-Path -LiteralPath $stagingArchivePath)) {
            $partial = Get-Item -LiteralPath $stagingArchivePath -Force
            if (-not ($partial -is [IO.FileInfo]) -or
                ($partial.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                -not [string]::Equals(
                    $partial.DirectoryName, $archiveParent,
                    [StringComparison]::OrdinalIgnoreCase) -or
                $partial.Name -cne $stagingLeaf) {
                throw "A failed canonical ZIP staging file changed identity."
            }
            [IO.File]::Delete($partial.FullName)
        }
    }
}
