function Get-ArtifactLowerSha256 {
    param([Parameter(Mandatory = $true)] [string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-ArtifactIntegralValue {
    param($Value)

    return $Value -is [byte] -or $Value -is [sbyte] -or
        $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64]
}

function Get-ArtifactRequiredPropertyValue {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $properties = @($Object.PSObject.Properties | Where-Object { $_.Name -ceq $Name })
    if ($properties.Count -ne 1 -or $null -eq $properties[0].Value) {
        throw "Artifact metadata is missing a unique non-null field: $Name"
    }
    # Keep JSON arrays as a single property value so callers can distinguish
    # them from scalar fields instead of accepting pipeline-unwrapped values.
    return ,$properties[0].Value
}

function Assert-ArtifactOrdinaryFile {
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [string]$Description,
        [switch]$AllowEmpty
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (-not $AllowEmpty -and $item.Length -le 0)) {
        $requirement = if ($AllowEmpty) { "an ordinary file" } else { "a non-empty ordinary file" }
        throw "$Description must be $requirement`: $Path"
    }
    return $item
}

function Write-ArtifactUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$Value
    )

    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function Read-ArtifactUtf8Strict {
    param([Parameter(Mandatory = $true)] [string]$Path)

    $null = Assert-ArtifactOrdinaryFile -Path $Path -Description "UTF-8 artifact"
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    return $encoding.GetString([IO.File]::ReadAllBytes($Path))
}

function Read-ArtifactJsonObjectStrict {
    param([Parameter(Mandatory = $true)] [string]$Path)

    $text = Read-ArtifactUtf8Strict -Path $Path
    $trimmed = $text.Trim()
    if ($trimmed.Length -lt 2 -or $trimmed[0] -ne '{' -or
        $trimmed[$trimmed.Length - 1] -ne '}') {
        throw "Artifact metadata must be a top-level JSON object."
    }
    try {
        $value = ConvertFrom-Json -InputObject $text
    }
    catch {
        throw "Artifact metadata is not valid JSON."
    }
    if (-not ($value -is [PSCustomObject])) {
        throw "Artifact metadata must decode to one JSON object."
    }
    return $value
}

function Get-ArtifactCanonicalDirectoryPath {
    param([Parameter(Mandatory = $true)] [string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    $trimmed = $full.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar)
    $trimmedRoot = $root.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar)
    if ([string]::Equals($trimmed, $trimmedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $root
    }
    return $trimmed
}

function Get-ArtifactRelativePath {
    param(
        [Parameter(Mandatory = $true)] [string]$Root,
        [Parameter(Mandatory = $true)] [string]$Path
    )

    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $prefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Artifact path is outside its declared root: $fullPath"
    }
    return $fullPath.Substring($prefix.Length).Replace('\', '/')
}

function Assert-ArtifactSafeRelativePath {
    param([Parameter(Mandatory = $true)] [string]$Path)

    $normalized = $Path.Replace('\', '/')
    $segments = @($normalized.Split('/') | Where-Object { $_.Length -gt 0 })
    if ($segments.Count -eq 0 -or $normalized.StartsWith('/') -or
        [IO.Path]::IsPathRooted($Path) -or
        @($segments | Where-Object { $_ -eq '.' -or $_ -eq '..' -or $_.Contains(':') }).Count -gt 0) {
        throw "Artifact record contains an unsafe relative path: $Path"
    }
    return [string]::Join('/', $segments)
}

function Assert-ArtifactPathChainNoReparse {
    param(
        [Parameter(Mandatory = $true)] [string]$Root,
        [Parameter(Mandatory = $true)] [string]$Path
    )

    $fullRoot = Get-ArtifactCanonicalDirectoryPath -Path $Root
    $relative = Get-ArtifactRelativePath -Root $fullRoot -Path $Path
    $current = $fullRoot
    $paths = @($fullRoot)
    foreach ($segment in $relative.Split('/')) {
        $current = Join-Path $current $segment
        $paths += $current
    }
    foreach ($candidate in $paths) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $item = Get-Item -LiteralPath $candidate -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Artifact path chain contains a reparse point."
        }
    }
}
