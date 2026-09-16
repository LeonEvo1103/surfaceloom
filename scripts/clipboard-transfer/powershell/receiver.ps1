param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Chunk", "Frame", "Loop", "Status", "Finalize", "Cleanup")]
    [string]$Action,
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$ManifestHash,
    [int]$Index = -1,
    [int]$RawLength = -1,
    [string]$ChunkHash = "",
    [string]$Payload = "",
    [string]$Frame = ""
)

$ErrorActionPreference = "Stop"
$script:failureCode = "CT_INTERNAL_ERROR"
$stateName = ".slm-clipboard-transfer"
$maxTotalBytes = 67108864L
$maxChunkBytes = 1048576
$maxChunks = 100000
$maxWorkingRootChars = 120
$maxFullPathChars = 240
$utf8 = [Text.UTF8Encoding]::new($false, $true)

function Stop-Transfer([string]$Code) {
    $script:failureCode = $Code
    throw [InvalidOperationException]::new($Code)
}

function Get-Sha256([string]$Path) {
    $stream = $null
    $algorithm = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
        if ($null -ne $algorithm) { $algorithm.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Assert-PlainItem([string]$Path, [bool]$Directory, [string]$MissingCode) {
    if (-not (Test-Path -LiteralPath $Path)) { Stop-Transfer $MissingCode }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Transfer "CT_REPARSE_REJECTED" }
    if ($Directory -ne [bool]$item.PSIsContainer) { Stop-Transfer "CT_PATH_REJECTED" }
}

function Enter-SessionLock([string]$Root) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Root.ToUpperInvariant() + "|" + $SessionId)
    $hash = Get-BytesSha256 $bytes
    $mutex = [Threading.Mutex]::new($false, ("Local\SurfaceLoomClipboard-" + $hash))
    try {
        try { $acquired = $mutex.WaitOne(30000) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { $mutex.Dispose(); Stop-Transfer "CT_SESSION_BUSY" }
        return $mutex
    } catch {
        if ($null -ne $mutex) { $mutex.Dispose() }
        throw
    }
}

function Get-SafeRoot {
    $location = Get-Location
    if ($location.Provider.Name -cne "FileSystem") { Stop-Transfer "CT_PATH_REJECTED" }
    if ($location.ProviderPath.Length -gt $maxWorkingRootChars) { Stop-Transfer "CT_PATH_TOO_LONG" }
    $root = [IO.Path]::GetFullPath($location.ProviderPath)
    if ($root.Length -gt $maxWorkingRootChars) { Stop-Transfer "CT_PATH_TOO_LONG" }
    $item = Get-Item -LiteralPath $root -Force
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Transfer "CT_REPARSE_REJECTED" }
        $item = $item.Parent
    }
    return $root
}

function Test-TargetName([string]$Name) {
    if ([string]::IsNullOrEmpty($Name) -or $Name.Length -gt 240) { return $false }
    if ($Name -cne $Name.Normalize([Text.NormalizationForm]::FormC)) { return $false }
    if ($Name -eq "." -or $Name -eq ".." -or $Name -match '[ .]$') { return $false }
    if ($Name -match '[<>:"/\\|?*\x00-\x1f]') { return $false }
    if ($Name -match '^(?i:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3])(?:\..*)?$') { return $false }
    if ($Name.ToLowerInvariant() -eq $stateName -or $Name.ToLowerInvariant().StartsWith(".slm-clipboard-")) { return $false }
    return ([IO.Path]::GetFileName($Name) -ceq $Name)
}

function Read-Manifest([string]$Root) {
    $state = [IO.Path]::Combine($Root, $stateName)
    $session = [IO.Path]::Combine($state, $SessionId)
    Assert-PlainItem $state $true "CT_SESSION_MISSING"
    Assert-PlainItem $session $true "CT_SESSION_MISSING"
    $manifestPath = [IO.Path]::Combine($session, "manifest.json")
    Assert-PlainItem $manifestPath $false "CT_SESSION_MISSING"
    if ((Get-Sha256 $manifestPath) -cne $ManifestHash) { Stop-Transfer "CT_SESSION_CONFLICT" }
    $text = $utf8.GetString([IO.File]::ReadAllBytes($manifestPath))
    $manifest = ConvertFrom-Json -InputObject $text
    if ($manifest -isnot [pscustomobject]) { Stop-Transfer "CT_MANIFEST_INVALID" }
    if ((@($manifest.PSObject.Properties.Name) -join ",") -cne "protocol,sessionId,targetName,totalLength,fileSha256,chunkRawBytes,chunkCount") { Stop-Transfer "CT_MANIFEST_INVALID" }
    if ($manifest.protocol -isnot [string] -or $manifest.sessionId -isnot [string] -or $manifest.targetName -isnot [string] -or $manifest.fileSha256 -isnot [string]) { Stop-Transfer "CT_MANIFEST_INVALID" }
    if (($manifest.totalLength -isnot [int] -and $manifest.totalLength -isnot [long]) -or
        ($manifest.chunkRawBytes -isnot [int] -and $manifest.chunkRawBytes -isnot [long]) -or
        ($manifest.chunkCount -isnot [int] -and $manifest.chunkCount -isnot [long])) { Stop-Transfer "CT_MANIFEST_INVALID" }
    if ($manifest.protocol -cne "slm-clipboard-v1" -or $manifest.sessionId -cne $SessionId) { Stop-Transfer "CT_MANIFEST_INVALID" }
    if (-not (Test-TargetName $manifest.targetName)) { Stop-Transfer "CT_MANIFEST_INVALID" }
    $total = [long]$manifest.totalLength
    $rawSize = [long]$manifest.chunkRawBytes
    $rawCount = [long]$manifest.chunkCount
    if ($total -lt 0 -or $total -gt $maxTotalBytes -or $rawSize -lt 1 -or $rawSize -gt $maxChunkBytes -or $rawCount -lt 0 -or $rawCount -gt $maxChunks) { Stop-Transfer "CT_MANIFEST_INVALID" }
    $size = [int]$rawSize
    $count = [int]$rawCount
    $expectedCount = if ($total -eq 0) { 0 } else { [long][Math]::Ceiling($total / [double]$size) }
    if ($count -ne $expectedCount -or $manifest.fileSha256 -cnotmatch '^[a-f0-9]{64}$') { Stop-Transfer "CT_MANIFEST_INVALID" }
    $canonical = [ordered]@{ protocol = [string]$manifest.protocol; sessionId = [string]$manifest.sessionId; targetName = [string]$manifest.targetName; totalLength = $total; fileSha256 = [string]$manifest.fileSha256; chunkRawBytes = $size; chunkCount = $count } | ConvertTo-Json -Compress
    if ($canonical -cne $text) { Stop-Transfer "CT_MANIFEST_INVALID" }
    if (($Root.Length + 1 + $manifest.targetName.Length) -gt $maxFullPathChars) { Stop-Transfer "CT_PATH_TOO_LONG" }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, [string]$manifest.targetName))
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($target), $Root, [StringComparison]::OrdinalIgnoreCase)) { Stop-Transfer "CT_PATH_REJECTED" }
    return [pscustomobject]@{ Value = $manifest; State = $state; Session = $session; Target = $target }
}

function Get-ExpectedChunkLength($Manifest, [int]$ChunkIndex) {
    if ($ChunkIndex -lt 0 -or $ChunkIndex -ge [int]$Manifest.chunkCount) { Stop-Transfer "CT_CHUNK_INDEX_INVALID" }
    $remaining = [long]$Manifest.totalLength - ([long]$ChunkIndex * [int]$Manifest.chunkRawBytes)
    return [int][Math]::Min([int]$Manifest.chunkRawBytes, $remaining)
}

function Convert-CanonicalBase64([string]$Value, [int]$ExpectedRawLength) {
    $expectedEncodedLength = 4 * [int][Math]::Ceiling($ExpectedRawLength / 3.0)
    if ($null -eq $Value -or $Value.Length -ne $expectedEncodedLength -or ($Value.Length % 4) -ne 0 -or $Value -cnotmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') { Stop-Transfer "CT_BASE64_INVALID" }
    $bytes = [Convert]::FromBase64String($Value)
    if ([Convert]::ToBase64String($bytes) -cne $Value) { Stop-Transfer "CT_BASE64_INVALID" }
    return ,$bytes
}

function Get-BytesSha256([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Read-Chunk([string]$Path, $Manifest, [int]$ExpectedIndex) {
    Assert-PlainItem $Path $false "CT_CHUNK_MISSING"
    $text = $utf8.GetString([IO.File]::ReadAllBytes($Path))
    $frame = ConvertFrom-Json -InputObject $text
    if ($frame -is [Array] -or $null -eq $frame -or ((@($frame.PSObject.Properties.Name) -join ",") -cne "i,l,s,p")) { Stop-Transfer "CT_CHUNK_CORRUPT" }
    $canonical = [ordered]@{ i = [int]$frame.i; l = [int]$frame.l; s = [string]$frame.s; p = [string]$frame.p } | ConvertTo-Json -Compress
    if ($canonical -cne $text -or [int]$frame.i -ne $ExpectedIndex) { Stop-Transfer "CT_CHUNK_CORRUPT" }
    $expectedLength = Get-ExpectedChunkLength $Manifest $ExpectedIndex
    $bytes = Convert-CanonicalBase64 ([string]$frame.p) $expectedLength
    if ([int]$frame.l -ne $expectedLength -or $bytes.Length -ne $expectedLength) { Stop-Transfer "CT_CHUNK_CORRUPT" }
    if ([string]$frame.s -cnotmatch '^[a-f0-9]{64}$' -or (Get-BytesSha256 $bytes) -cne [string]$frame.s) { Stop-Transfer "CT_CHUNK_CORRUPT" }
    return [pscustomobject]@{ Bytes = $bytes; Hash = [string]$frame.s; Payload = [string]$frame.p; Length = [int]$frame.l }
}

function Format-Ranges([System.Collections.Generic.List[int]]$Indices) {
    if ($Indices.Count -eq 0) { return "none" }
    $parts = [Collections.Generic.List[string]]::new()
    $start = $Indices[0]
    $end = $start
    $rangeCount = 1
    foreach ($value in $Indices | Select-Object -Skip 1) {
        if ($value -eq $end + 1) { $end = $value; continue }
        [void]$parts.Add($(if ($start -eq $end) { "$start" } else { "$start-$end" }))
        $rangeCount++
        if ($parts.Count -ge 256) { return (($parts -join ",") + ",...(+more)") }
        $start = $value
        $end = $value
    }
    [void]$parts.Add($(if ($start -eq $end) { "$start" } else { "$start-$end" }))
    return $parts -join ","
}

function Get-ChunkDirectory($Context, [bool]$Create) {
    $directory = [IO.Path]::Combine($Context.Session, "chunks")
    if ($Create -and -not (Test-Path -LiteralPath $directory)) { [void][IO.Directory]::CreateDirectory($directory) }
    Assert-PlainItem $directory $true "CT_CHUNK_MISSING"
    return $directory
}

function Save-Chunk(
    $Context,
    [int]$ChunkIndex,
    [int]$ChunkRawLength,
    [string]$ExpectedChunkHash,
    [string]$ChunkPayload
) {
    $manifest = $Context.Value
    $expectedLength = Get-ExpectedChunkLength $manifest $ChunkIndex
    if ($ChunkRawLength -ne $expectedLength -or $ExpectedChunkHash -cnotmatch '^[a-f0-9]{64}$') { Stop-Transfer "CT_CHUNK_METADATA_INVALID" }
    $bytes = Convert-CanonicalBase64 $ChunkPayload $expectedLength
    if ($bytes.Length -ne $ChunkRawLength -or (Get-BytesSha256 $bytes) -cne $ExpectedChunkHash) { Stop-Transfer "CT_CHUNK_INTEGRITY_FAILED" }
    $directory = Get-ChunkDirectory $Context $true
    $path = [IO.Path]::Combine($directory, ("{0:D8}.chunk.json" -f $ChunkIndex))
    if (Test-Path -LiteralPath $path) {
        $existing = Read-Chunk $path $manifest $ChunkIndex
        if ($existing.Length -ne $ChunkRawLength -or $existing.Hash -cne $ExpectedChunkHash -or $existing.Payload -cne $ChunkPayload) { Stop-Transfer "CT_CHUNK_CONFLICT" }
        Write-Output ("CT_CHUNK_OK SESSION={0} INDEX={1} STATE=already-present" -f $SessionId, $ChunkIndex)
        return
    }
    $frame = [ordered]@{ i = $ChunkIndex; l = $ChunkRawLength; s = $ExpectedChunkHash; p = $ChunkPayload } | ConvertTo-Json -Compress
    $temporary = [IO.Path]::Combine($directory, (".tmp-" + [Guid]::NewGuid().ToString("N")))
    try {
        [IO.File]::WriteAllText($temporary, $frame, $utf8)
        [IO.File]::Move($temporary, $path)
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
    Write-Output ("CT_CHUNK_OK SESSION={0} INDEX={1} STATE=stored" -f $SessionId, $ChunkIndex)
}

function Get-MissingChunks($Context, [bool]$ValidatePresent) {
    $missing = [Collections.Generic.List[int]]::new()
    $directory = Get-ChunkDirectory $Context $true
    for ($current = 0; $current -lt [int]$Context.Value.chunkCount; $current++) {
        $path = [IO.Path]::Combine($directory, ("{0:D8}.chunk.json" -f $current))
        if (-not (Test-Path -LiteralPath $path)) { [void]$missing.Add($current) }
        elseif ($ValidatePresent) { [void](Read-Chunk $path $Context.Value $current) }
    }
    return ,$missing
}

function Show-Status($Context) {
    $missing = Get-MissingChunks $Context $true
    $received = [int]$Context.Value.chunkCount - $missing.Count
    Write-Output ("CT_STATUS SESSION={0} RECEIVED={1}/{2} MISSING={3}" -f $SessionId, $received, $Context.Value.chunkCount, (Format-Ranges $missing))
}

function Assert-ExactChunkSet($Context) {
    $directory = Get-ChunkDirectory $Context $true
    $expected = [int]$Context.Value.chunkCount
    $files = @(Get-ChildItem -LiteralPath $directory -Force)
    if ($files.Count -ne $expected) { Stop-Transfer "CT_CHUNK_SET_CONFLICT" }
    foreach ($file in $files) {
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Name -cnotmatch '^\d{8}\.chunk\.json$') { Stop-Transfer "CT_CHUNK_SET_CONFLICT" }
        $parsedIndex = [int]$file.Name.Substring(0, 8)
        if ($parsedIndex -lt 0 -or $parsedIndex -ge $expected) { Stop-Transfer "CT_CHUNK_SET_CONFLICT" }
    }
}

function Test-ExistingTarget($Context) {
    if (-not (Test-Path -LiteralPath $Context.Target)) { return $false }
    Assert-PlainItem $Context.Target $false "CT_TARGET_CONFLICT"
    $item = Get-Item -LiteralPath $Context.Target -Force
    if ($item.Length -ne [long]$Context.Value.totalLength -or (Get-Sha256 $Context.Target) -cne [string]$Context.Value.fileSha256) { Stop-Transfer "CT_TARGET_CONFLICT" }
    return $true
}

function Complete-Transfer($Context) {
    if (Test-ExistingTarget $Context) {
        Write-Output ("CT_FINALIZE_OK SESSION={0} STATE=already-present BYTES={1} SHA256={2}" -f $SessionId, $Context.Value.totalLength, $Context.Value.fileSha256)
        return
    }
    $missing = Get-MissingChunks $Context $false
    if ($missing.Count -gt 0) {
        Write-Output ("CT_STATUS SESSION={0} RECEIVED={1}/{2} MISSING={3}" -f $SessionId, ([int]$Context.Value.chunkCount - $missing.Count), $Context.Value.chunkCount, (Format-Ranges $missing))
        Stop-Transfer "CT_CHUNKS_MISSING"
    }
    Assert-ExactChunkSet $Context
    $partial = [IO.Path]::Combine((Split-Path -Parent $Context.Target), (".slm-clipboard-{0}.partial" -f $SessionId))
    if (Test-Path -LiteralPath $partial) { Assert-PlainItem $partial $false "CT_PARTIAL_CONFLICT"; Remove-Item -LiteralPath $partial -Force }
    $stream = $null
    $moved = $false
    try {
        $stream = [IO.File]::Open($partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $directory = Get-ChunkDirectory $Context $false
        for ($current = 0; $current -lt [int]$Context.Value.chunkCount; $current++) {
            $chunk = Read-Chunk ([IO.Path]::Combine($directory, ("{0:D8}.chunk.json" -f $current))) $Context.Value $current
            $stream.Write($chunk.Bytes, 0, $chunk.Bytes.Length)
        }
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        $partialItem = Get-Item -LiteralPath $partial -Force
        if ($partialItem.Length -ne [long]$Context.Value.totalLength -or (Get-Sha256 $partial) -cne [string]$Context.Value.fileSha256) { Stop-Transfer "CT_FINAL_INTEGRITY_FAILED" }
        if (Test-ExistingTarget $Context) { Remove-Item -LiteralPath $partial -Force }
        else {
            try { [IO.File]::Move($partial, $Context.Target); $moved = $true }
            catch {
                if (Test-ExistingTarget $Context) { Remove-Item -LiteralPath $partial -Force }
                else { Stop-Transfer "CT_TARGET_CONFLICT" }
            }
        }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if (-not $moved -and (Test-Path -LiteralPath $partial)) {
            try { Assert-PlainItem $partial $false "CT_PARTIAL_CONFLICT"; Remove-Item -LiteralPath $partial -Force } catch { }
        }
    }
    Write-Output ("CT_FINALIZE_OK SESSION={0} STATE=created BYTES={1} SHA256={2}" -f $SessionId, $Context.Value.totalLength, $Context.Value.fileSha256)
}

function Remove-Transfer([string]$Root) {
    $state = [IO.Path]::Combine($Root, $stateName)
    $session = [IO.Path]::Combine($state, $SessionId)
    $partial = [IO.Path]::Combine($Root, (".slm-clipboard-{0}.partial" -f $SessionId))
    if (Test-Path -LiteralPath $partial) { Assert-PlainItem $partial $false "CT_PARTIAL_CONFLICT"; Remove-Item -LiteralPath $partial -Force }
    if (-not (Test-Path -LiteralPath $session)) { Write-Output ("CT_CLEANUP_OK SESSION={0} STATE=already-clean" -f $SessionId); return }
    Assert-PlainItem $state $true "CT_SESSION_MISSING"
    Assert-PlainItem $session $true "CT_SESSION_MISSING"
    foreach ($item in Get-ChildItem -LiteralPath $session -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Transfer "CT_REPARSE_REJECTED" }
        if ($item.Name -eq "manifest.json" -and -not $item.PSIsContainer) { continue }
        if (($item.Name -eq "chunks" -or $item.Name -eq "bootstrap") -and $item.PSIsContainer) { continue }
        Stop-Transfer "CT_CLEANUP_CONFLICT"
    }
    $chunks = [IO.Path]::Combine($session, "chunks")
    if (Test-Path -LiteralPath $chunks) {
        Assert-PlainItem $chunks $true "CT_CLEANUP_CONFLICT"
        foreach ($item in Get-ChildItem -LiteralPath $chunks -Force) {
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Name -notmatch '^(?:\d{8}\.chunk\.json|\.tmp-[a-f0-9]{32})$') { Stop-Transfer "CT_CLEANUP_CONFLICT" }
            Remove-Item -LiteralPath $item.FullName -Force
        }
        Remove-Item -LiteralPath $chunks -Force
    }
    $bootstrap = [IO.Path]::Combine($session, "bootstrap")
    if (Test-Path -LiteralPath $bootstrap) {
        Assert-PlainItem $bootstrap $true "CT_CLEANUP_CONFLICT"
        foreach ($item in Get-ChildItem -LiteralPath $bootstrap -Force) {
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Name -cnotmatch '^(?:engine-manifest\.json|engine\.(?:gz(?:\.work)?|raw\.work)|\d{4}\.part|\.tmp-[a-f0-9]{32})$') { Stop-Transfer "CT_CLEANUP_CONFLICT" }
            Remove-Item -LiteralPath $item.FullName -Force
        }
        Remove-Item -LiteralPath $bootstrap -Force
    }
    Remove-Item -LiteralPath ([IO.Path]::Combine($session, "manifest.json")) -Force
    Remove-Item -LiteralPath $session -Force
    Write-Output ("CT_CLEANUP_OK SESSION={0} STATE=removed" -f $SessionId)
}

function Invoke-DataFrame($Context, [string]$Line, [string]$Root) {
    if ($null -eq $Line -or $Line.Length -gt 1800 -or $Line -match "[`r`n`0]") { Stop-Transfer "CT_FRAME_INVALID" }
    $fields = @($Line.Split('|'))
    if ($fields.Count -lt 3 -or $fields[0] -cne "SLMCT1" -or $fields[2] -cne $SessionId) { Stop-Transfer "CT_FRAME_INVALID" }
    if ($fields[1] -ceq "C") {
        if ($fields.Count -ne 7) { Stop-Transfer "CT_FRAME_INVALID" }
        $parsedIndex = 0
        $parsedLength = 0
        if (-not [int]::TryParse($fields[3], [ref]$parsedIndex) -or "$parsedIndex" -cne $fields[3]) { Stop-Transfer "CT_FRAME_INVALID" }
        if (-not [int]::TryParse($fields[4], [ref]$parsedLength) -or "$parsedLength" -cne $fields[4]) { Stop-Transfer "CT_FRAME_INVALID" }
        Save-Chunk $Context $parsedIndex $parsedLength ([string]$fields[5]) ([string]$fields[6])
    } elseif ($fields.Count -eq 3 -and $fields[1] -ceq "S") { Show-Status $Context }
    elseif ($fields.Count -eq 3 -and $fields[1] -ceq "F") { Complete-Transfer $Context }
    elseif ($fields.Count -eq 3 -and $fields[1] -ceq "Q") { Write-Output ("CT_LOOP_STOPPED SESSION={0}" -f $SessionId); $script:loopExit = $true }
    elseif ($fields.Count -eq 3 -and $fields[1] -ceq "X") { Remove-Transfer $Root; $script:loopExit = $true }
    else { Stop-Transfer "CT_FRAME_INVALID" }
}

function Start-ReceiveLoop($Context, [string]$Root) {
    $script:loopExit = $false
    Write-Output ("CT_LOOP_READY SESSION={0}" -f $SessionId)
    while (-not $script:loopExit) {
        $line = Read-Host
        try {
            $script:failureCode = "CT_INTERNAL_ERROR"
            Invoke-DataFrame $Context $line $Root
        } catch {
            Write-Output ("CT_ERROR {0}" -f $script:failureCode)
        }
        if (-not $script:loopExit) { Write-Output ("CT_LOOP_READY SESSION={0}" -f $SessionId) }
    }
}

$mutex = $null
$ownsMutex = $false
try {
    if ($SessionId -cnotmatch '^[a-f0-9]{32}$' -or $ManifestHash -cnotmatch '^[a-f0-9]{64}$') { Stop-Transfer "CT_ARGUMENT_INVALID" }
    $root = Get-SafeRoot
    $sessionPath = [IO.Path]::Combine([IO.Path]::Combine($root, $stateName), $SessionId)
    if ($Action -eq "Cleanup" -and -not (Test-Path -LiteralPath $sessionPath)) { Remove-Transfer $root }
    else {
        $mutex = Enter-SessionLock $root
        $ownsMutex = $true
        $context = Read-Manifest $root
        if ($Action -eq "Cleanup") { Remove-Transfer $root }
        elseif ($Action -eq "Chunk") { Save-Chunk $context $Index $RawLength $ChunkHash $Payload }
        elseif ($Action -eq "Frame") { Invoke-DataFrame $context $Frame $root }
        elseif ($Action -eq "Loop") { Start-ReceiveLoop $context $root }
        elseif ($Action -eq "Status") { Show-Status $context }
        elseif ($Action -eq "Finalize") { Complete-Transfer $context }
    }
    $global:LASTEXITCODE = 0
} catch {
    Write-Output ("CT_ERROR {0}" -f $script:failureCode)
    $global:LASTEXITCODE = 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
