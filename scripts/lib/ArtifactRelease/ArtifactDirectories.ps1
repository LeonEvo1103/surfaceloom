function Assert-ArtifactDirectoryTreeNoReparse {
    param([Parameter(Mandatory = $true)] [string]$Path)

    $directory = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $directory.PSIsContainer -or
        ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Artifact directory must be an ordinary directory: $Path"
    }
    $reparseItems = @(Get-ChildItem -LiteralPath $directory.FullName -Force -Recurse |
        Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
    if ($reparseItems.Count -ne 0) {
        throw "Artifact directory tree contains a reparse point: $Path"
    }
    return $directory
}

function Assert-ArtifactTreeHasNoEmptyDirectories {
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [string[]]$ExcludedDirectoryNames = @()
    )

    $root = Get-ArtifactCanonicalDirectoryPath -Path $Path
    $emptyDirectories = @(Get-ChildItem -LiteralPath $root -Directory -Force -Recurse |
        Where-Object {
            $relative = Get-ArtifactRelativePath -Root $root -Path $_.FullName
            $segments = @($relative.Split('/'))
            @($segments | Where-Object { $ExcludedDirectoryNames -contains $_ }).Count -eq 0 -and
                @(Get-ChildItem -LiteralPath $_.FullName -Force).Count -eq 0
        })
    if ($emptyDirectories.Count -ne 0) {
        throw "Artifact tree contains an unrecorded empty directory."
    }
}

function Remove-ArtifactEmptyDirectories {
    param([Parameter(Mandatory = $true)] [string]$Path)

    $root = Get-ArtifactCanonicalDirectoryPath -Path $Path
    $null = Assert-ArtifactDirectoryTreeNoReparse -Path $root
    $directories = @(Get-ChildItem -LiteralPath $root -Directory -Force -Recurse |
        Sort-Object { $_.FullName.Length } -Descending)
    foreach ($directory in $directories) {
        if (@(Get-ChildItem -LiteralPath $directory.FullName -Force).Count -eq 0) {
            Remove-Item -LiteralPath $directory.FullName -Force
        }
    }
    Assert-ArtifactTreeHasNoEmptyDirectories -Path $root
}

function Remove-ArtifactDirectorySafely {
    param(
        [Parameter(Mandatory = $true)] [string]$Directory,
        [Parameter(Mandatory = $true)] [string]$ExpectedParent,
        [Parameter(Mandatory = $true)] [string]$ExpectedLeafPattern
    )

    $fullDirectory = Get-ArtifactCanonicalDirectoryPath -Path $Directory
    $fullParent = Get-ArtifactCanonicalDirectoryPath -Path $ExpectedParent
    $actualParent = Get-ArtifactCanonicalDirectoryPath -Path (
        [IO.Path]::GetDirectoryName($fullDirectory))
    $leaf = [IO.Path]::GetFileName($fullDirectory)
    if (-not [string]::Equals(
            $actualParent,
            $fullParent,
            [StringComparison]::OrdinalIgnoreCase) -or
        $leaf -notmatch $ExpectedLeafPattern) {
        throw "Refusing to remove an artifact directory outside its declared scope."
    }
    if (-not (Test-Path -LiteralPath $fullDirectory)) { return }
    Assert-ArtifactPathChainNoReparse -Root $fullParent -Path $fullDirectory
    $null = Assert-ArtifactDirectoryTreeNoReparse -Path $fullDirectory
    Remove-Item -LiteralPath $fullDirectory -Force -Recurse
    if (Test-Path -LiteralPath $fullDirectory) {
        throw "Artifact directory cleanup did not complete."
    }
}

function Move-ArtifactDirectoryAtomically {
    param(
        [Parameter(Mandatory = $true)] [string]$StagingDirectory,
        [Parameter(Mandatory = $true)] [string]$FinalDirectory
    )

    $staging = Get-ArtifactCanonicalDirectoryPath -Path $StagingDirectory
    $final = Get-ArtifactCanonicalDirectoryPath -Path $FinalDirectory
    if (-not (Test-Path -LiteralPath $staging -PathType Container)) {
        throw "Artifact staging directory is missing: $staging"
    }
    if (Test-Path -LiteralPath $final) {
        throw "Artifact final directory already exists: $final"
    }
    if (-not [string]::Equals(
            [IO.Path]::GetDirectoryName($staging),
            [IO.Path]::GetDirectoryName($final),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Atomic artifact publication requires staging and final directories to share a parent."
    }
    $parent = Get-ArtifactCanonicalDirectoryPath -Path ([IO.Path]::GetDirectoryName($staging))
    Assert-ArtifactPathChainNoReparse -Root $parent -Path $staging
    $null = Assert-ArtifactDirectoryTreeNoReparse -Path $staging
    [IO.Directory]::Move($staging, $final)
}
