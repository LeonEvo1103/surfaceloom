function Get-ArtifactTreeRecords {
    param(
        [Parameter(Mandatory = $true)] [string]$Root,
        [string[]]$ExcludedRelativePaths = @()
    )

    $null = Assert-ArtifactDirectoryTreeNoReparse -Path $Root
    Assert-ArtifactTreeHasNoEmptyDirectories -Path $Root
    $excluded = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $ExcludedRelativePaths) {
        $null = $excluded.Add((Assert-ArtifactSafeRelativePath -Path $path))
    }
    return @(Get-ChildItem -LiteralPath $Root -File -Force -Recurse |
        ForEach-Object {
            $relative = Get-ArtifactRelativePath -Root $Root -Path $_.FullName
            if (-not $excluded.Contains($relative)) {
                $item = Assert-ArtifactOrdinaryFile `
                    -Path $_.FullName `
                    -Description "artifact payload" `
                    -AllowEmpty
                [PSCustomObject][ordered]@{
                    path = $relative
                    length = [long]$item.Length
                    sha256 = Get-ArtifactLowerSha256 -Path $item.FullName
                }
            }
        } |
        Sort-Object path)
}

function Assert-ArtifactRecords {
    param(
        [Parameter(Mandatory = $true)] [string]$Root,
        [Parameter(Mandatory = $true)] [object[]]$Records,
        [switch]$RequireExactFileSet,
        [string[]]$ExcludedRelativePaths = @()
    )

    $null = Assert-ArtifactDirectoryTreeNoReparse -Path $Root
    Assert-ArtifactTreeHasNoEmptyDirectories -Path $Root
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $Records) {
        $recordPathValue = Get-ArtifactRequiredPropertyValue -Object $record -Name "path"
        $lengthValue = Get-ArtifactRequiredPropertyValue -Object $record -Name "length"
        $sha256Value = Get-ArtifactRequiredPropertyValue -Object $record -Name "sha256"
        if (-not ($recordPathValue -is [string]) -or
            -not (Test-ArtifactIntegralValue $lengthValue) -or [long]$lengthValue -lt 0 -or
            -not ($sha256Value -is [string]) -or $sha256Value -cnotmatch '^[a-f0-9]{64}$') {
            throw "Artifact record has an invalid path, integral length, or SHA256."
        }
        $recordPath = $recordPathValue.Replace('\', '/')
        $relative = Assert-ArtifactSafeRelativePath -Path $recordPath
        if (-not [string]::Equals($recordPath, $relative, [StringComparison]::Ordinal)) {
            throw "Artifact record path is not canonical: $recordPath"
        }
        if (-not $seen.Add($relative)) { throw "Duplicate artifact record: $relative" }
        $path = Join-Path $Root $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $item = Assert-ArtifactOrdinaryFile `
            -Path $path `
            -Description "recorded artifact $relative" `
            -AllowEmpty
        if ([long]$item.Length -ne [long]$lengthValue -or
            (Get-ArtifactLowerSha256 -Path $item.FullName) -cne $sha256Value) {
            throw "Artifact payload does not match its record: $relative"
        }
    }
    if ($RequireExactFileSet) {
        $actual = Get-ArtifactTreeRecords -Root $Root -ExcludedRelativePaths $ExcludedRelativePaths
        if ($actual.Count -ne $Records.Count -or
            @($actual | Where-Object { -not $seen.Contains($_.path) }).Count -ne 0) {
            throw "Artifact record set does not exactly match the payload tree."
        }
    }
}

function Write-ArtifactSha256Sums {
    param(
        [Parameter(Mandatory = $true)] [string]$Root,
        [Parameter(Mandatory = $true)] [string]$Path
    )

    $relativeSumsPath = Get-ArtifactRelativePath -Root $Root -Path $Path
    $records = Get-ArtifactTreeRecords `
        -Root $Root `
        -ExcludedRelativePaths $relativeSumsPath
    $value = ($records | ForEach-Object {
            "{0}  {1}" -f $_.sha256, $_.path
        }) -join "`n"
    Write-ArtifactUtf8NoBom -Path $Path -Value ($value + "`n")
}

function Assert-ArtifactSha256Sums {
    param(
        [Parameter(Mandatory = $true)] [string]$Root,
        [Parameter(Mandatory = $true)] [string]$Path
    )

    $relativeSumsPath = Get-ArtifactRelativePath -Root $Root -Path $Path
    $text = Read-ArtifactUtf8Strict -Path $Path
    $normalizedText = $text.Replace("`r`n", "`n")
    if ($normalizedText.Contains("`r") -or -not $normalizedText.EndsWith("`n")) {
        throw "SHA256SUMS must use UTF-8 text with one newline-terminated record per line."
    }
    $body = $normalizedText.Substring(0, $normalizedText.Length - 1)
    $lines = if ($body.Length -eq 0) { @() } else { @($body.Split("`n")) }
    if (@($lines | Where-Object { $_.Length -eq 0 }).Count -ne 0) {
        throw "SHA256SUMS contains an empty record."
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $declared = [Collections.Generic.Dictionary[string, string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $lines) {
        if ($line -notmatch '^([a-f0-9]{64})  (.+)$') {
            throw "SHA256SUMS contains an invalid line."
        }
        $relative = Assert-ArtifactSafeRelativePath -Path $Matches[2]
        if (-not [string]::Equals($Matches[2], $relative, [StringComparison]::Ordinal)) {
            throw "SHA256SUMS contains a non-canonical path: $($Matches[2])"
        }
        if (-not $seen.Add($relative)) {
            throw "SHA256SUMS contains a duplicate path: $relative"
        }
        $declared[$relative] = $Matches[1]
    }
    $actual = Get-ArtifactTreeRecords `
        -Root $Root `
        -ExcludedRelativePaths $relativeSumsPath
    if ($actual.Count -ne $declared.Count) {
        throw "SHA256SUMS does not exactly match the artifact tree."
    }
    foreach ($record in $actual) {
        if (-not $declared.ContainsKey($record.path) -or
            -not [string]::Equals(
                $declared[$record.path],
                $record.sha256,
                [StringComparison]::Ordinal)) {
            throw "SHA256SUMS does not match artifact: $($record.path)"
        }
    }
}
