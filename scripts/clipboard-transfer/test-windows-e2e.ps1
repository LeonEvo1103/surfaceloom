[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Outbox,
    [string]$WorkingRoot = ""
)

$ErrorActionPreference = "Stop"
$outboxPath = (Resolve-Path -LiteralPath $Outbox).ProviderPath
$outboxItem = Get-Item -LiteralPath $outboxPath -Force
if (-not $outboxItem.PSIsContainer -or ($outboxItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "CT_WINDOWS_E2E_OUTBOX_INVALID"
}
$ready = [IO.Path]::Combine($outboxPath, "READY")
if ([IO.File]::ReadAllText($ready, [Text.Encoding]::ASCII) -cne "slm-clipboard-v1`n") {
    throw "CT_WINDOWS_E2E_OUTBOX_INVALID"
}
$plan = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText([IO.Path]::Combine($outboxPath, "plan.json")))
$workingRootPath = if ([string]::IsNullOrEmpty($WorkingRoot)) {
    [IO.Path]::GetTempPath()
} else {
    (Resolve-Path -LiteralPath $WorkingRoot).ProviderPath
}
$workingRootItem = Get-Item -LiteralPath $workingRootPath -Force
if (-not $workingRootItem.PSIsContainer -or ($workingRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "CT_WINDOWS_E2E_WORKING_ROOT_INVALID"
}
$working = [IO.Path]::Combine($workingRootPath, ("slm-clipboard-e2e-" + [Guid]::NewGuid().ToString("N")))
[void][IO.Directory]::CreateDirectory($working)

function Invoke-Frame([string]$RelativePath, [string]$ExpectedError = "") {
    $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($outboxPath, $RelativePath.Replace("/", [IO.Path]::DirectorySeparatorChar)))
    if (-not $candidate.StartsWith($outboxPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "CT_WINDOWS_E2E_FRAME_PATH_INVALID"
    }
    $item = Get-Item -LiteralPath $candidate -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "CT_WINDOWS_E2E_FRAME_PATH_INVALID"
    }
    $frame = [IO.File]::ReadAllText($candidate, [Text.Encoding]::ASCII)
    if ($frame.Length -gt [int]$plan.maxCommandChars -or $frame -match "[`r`n`0]") {
        throw "CT_WINDOWS_E2E_FRAME_INVALID"
    }
    $output = @(& ([scriptblock]::Create($frame)))
    if (-not [string]::IsNullOrEmpty($ExpectedError)) {
        if ($global:LASTEXITCODE -ne 1 -or $output.Count -ne 1 -or
            [string]$output[0] -cne ("CT_ERROR {0}" -f $ExpectedError)) {
            $output | ForEach-Object { Write-Output $_ }
            throw ("CT_WINDOWS_E2E_WRONG_ERROR {0}" -f $RelativePath)
        }
        return
    }
    if ($global:LASTEXITCODE -ne 0) {
        $output | ForEach-Object { Write-Output $_ }
        throw ("CT_WINDOWS_E2E_FRAME_FAILED {0}" -f $RelativePath)
    }
    $output | ForEach-Object { Write-Output $_ }
}

function Invoke-ProtocolFrame([string]$RelativePath, [string]$ExpectedError = "") {
    $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($outboxPath, $RelativePath.Replace("/", [IO.Path]::DirectorySeparatorChar)))
    $frame = [IO.File]::ReadAllText($candidate, [Text.Encoding]::ASCII)
    if ($frame.Length -gt [int]$plan.maxCommandChars -or $frame -match "[`r`n`0]") { throw "CT_WINDOWS_E2E_FRAME_INVALID" }
    $output = & $script:receiver -Action "Frame" -SessionId ([string]$plan.sessionId) -ManifestHash ([string]$plan.manifestSha256) -Frame $frame
    if (-not [string]::IsNullOrEmpty($ExpectedError)) {
        if ($global:LASTEXITCODE -ne 1 -or @($output).Count -ne 1 -or
            [string]@($output)[0] -cne ("CT_ERROR {0}" -f $ExpectedError)) {
            @($output) | ForEach-Object { Write-Output $_ }
            throw ("CT_WINDOWS_E2E_WRONG_PROTOCOL_ERROR {0}" -f $RelativePath)
        }
        return
    }
    if ($global:LASTEXITCODE -ne 0) {
        @($output) | ForEach-Object { Write-Output $_ }
        throw ("CT_WINDOWS_E2E_FRAME_FAILED {0}" -f $RelativePath)
    }
    @($output) | ForEach-Object { Write-Output $_ }
}

function Test-PathBudgetPreflight {
    $deepRoot = $working
    while ($deepRoot.Length -le 125) {
        $deepRoot = [IO.Path]::Combine($deepRoot, "deep-root-segment")
        [void][IO.Directory]::CreateDirectory($deepRoot)
    }
    $firstInit = [string](@($plan.initCommandFiles)[0])
    $framePath = [IO.Path]::Combine($outboxPath, $firstInit.Replace("/", [IO.Path]::DirectorySeparatorChar))
    $frame = [IO.File]::ReadAllText($framePath, [Text.Encoding]::ASCII)
    Push-Location -LiteralPath $deepRoot
    try {
        $output = @(& ([scriptblock]::Create($frame)))
        if ($global:LASTEXITCODE -ne 1 -or $output.Count -ne 1 -or
            [string]$output[0] -cne "CT_ERROR CT_PATH_TOO_LONG") {
            throw "CT_WINDOWS_E2E_PATH_PREFLIGHT_FAILED"
        }
        if (Test-Path -LiteralPath ([IO.Path]::Combine($deepRoot, ".slm-clipboard-transfer"))) {
            throw "CT_WINDOWS_E2E_PATH_PREFLIGHT_MUTATED"
        }
    } finally {
        Pop-Location
    }
    Write-Output "CT_WINDOWS_PATH_PREFLIGHT_OK"
}

function Test-InventoryDiagnostics([string]$InventoryFrame) {
    $inventoryPath = [IO.Path]::GetFullPath([IO.Path]::Combine($outboxPath, $InventoryFrame.Replace("/", [IO.Path]::DirectorySeparatorChar)))
    $inventoryText = [IO.File]::ReadAllText($inventoryPath, [Text.Encoding]::ASCII)
    $encoded = [regex]::Match($inventoryText, "FromBase64String\('([A-Za-z0-9+/=]+)'\)").Groups[1]
    if (-not $encoded.Success) { throw "CT_WINDOWS_E2E_INVENTORY_FRAME_INVALID" }
    $replacement = if ([string]$inventoryText[$encoded.Index] -ceq "A") { "B" } else { "A" }
    $corruptFrame = $inventoryText.Remove($encoded.Index, 1).Insert($encoded.Index, $replacement)
    $output = @(& ([scriptblock]::Create($corruptFrame)))
    if ($global:LASTEXITCODE -ne 1 -or $output.Count -ne 1 -or
        [string]$output[0] -cne "CT_ERROR CT_INIT_INV_FRAME_INVALID") {
        throw "CT_WINDOWS_E2E_INVENTORY_FRAME_GUARD_FAILED"
    }

    $bootstrap = [IO.Path]::Combine($working, ".slm-clipboard-transfer", [string]$plan.sessionId, "bootstrap")
    $engineManifest = [IO.Path]::Combine($bootstrap, "engine-manifest.json")
    $originalManifest = [IO.File]::ReadAllBytes($engineManifest)
    $alteredManifest = [byte[]]$originalManifest.Clone()
    $alteredManifest[0] = $alteredManifest[0] -bxor 1
    [IO.File]::WriteAllBytes($engineManifest, $alteredManifest)
    try {
        Invoke-Frame $InventoryFrame "CT_INIT_INV_MANIFEST_HASH"
    } finally {
        [IO.File]::WriteAllBytes($engineManifest, $originalManifest)
    }

    $part = [IO.Path]::Combine($bootstrap, "0000.part")
    $heldPart = [IO.Path]::Combine($working, ".slm-inventory-held-part")
    [IO.File]::Move($part, $heldPart)
    try {
        Invoke-Frame $InventoryFrame "CT_INIT_INV_PART_COUNT"
    } finally {
        [IO.File]::Move($heldPart, $part)
    }

    $unexpected = [IO.Path]::Combine($bootstrap, "unexpected.item")
    [IO.File]::WriteAllBytes($unexpected, [byte[]]@(0))
    try {
        Invoke-Frame $InventoryFrame "CT_INIT_INV_ITEM"
    } finally {
        Remove-Item -LiteralPath $unexpected -Force
    }
    Write-Output "CT_WINDOWS_INVENTORY_DIAGNOSTICS_OK"
}

try {
    Test-PathBudgetPreflight
    Push-Location -LiteralPath $working
    try {
        $firstInit = [string](@($plan.initCommandFiles)[0])
        Invoke-Frame $firstInit
        $sessionPath = [IO.Path]::Combine($working, ".slm-clipboard-transfer", [string]$plan.sessionId)
        if (-not (Test-Path -LiteralPath $sessionPath -PathType Container)) {
            throw "CT_WINDOWS_E2E_ABORT_SETUP_FAILED"
        }
        Invoke-Frame ([string]$plan.abortInit)
        if (Test-Path -LiteralPath $sessionPath) { throw "CT_WINDOWS_E2E_ABORT_FAILED" }
        Write-Output "CT_WINDOWS_ABORT_WITHOUT_MANIFEST_OK"
        $inventory = @($plan.initCommands | Where-Object { [string]$_.expectedMarker -like "CT_INIT_INVENTORY_OK*" })
        if ($inventory.Count -ne 1) { throw "CT_WINDOWS_E2E_INVENTORY_FRAME_INVALID" }
        $inventoryFrame = [string]$inventory[0].commandFile
        foreach ($entry in @($plan.initCommands)) {
            $frame = [string]$entry.commandFile
            if ($frame -ceq $inventoryFrame) { Test-InventoryDiagnostics $inventoryFrame }
            Invoke-Frame $frame
        }
        $inflate = @($plan.initCommands | Where-Object { [string]$_.expectedMarker -ceq "CT_INIT_INFLATE_OK" })
        $publishEngine = @($plan.initCommands | Where-Object { [string]$_.expectedMarker -ceq "CT_INIT_ENGINE_OK" })
        if ($inflate.Count -ne 1 -or $publishEngine.Count -ne 1) {
            throw "CT_WINDOWS_E2E_ENGINE_REPLAY_SETUP_FAILED"
        }
        # A replay after the shared hash-pinned engine exists legitimately leaves
        # engine.raw.work in this session; Cleanup must recognize that exact file.
        Invoke-Frame ([string]$inflate[0].commandFile)
        Invoke-Frame ([string]$publishEngine[0].commandFile)
        $rawWork = [IO.Path]::Combine($working, ".slm-clipboard-transfer", [string]$plan.sessionId, "bootstrap", "engine.raw.work")
        $rawWorkItem = Get-Item -LiteralPath $rawWork -Force
        if ($rawWorkItem.PSIsContainer -or ($rawWorkItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "CT_WINDOWS_E2E_ENGINE_REPLAY_RESIDUE_INVALID"
        }
        Write-Output "CT_WINDOWS_ENGINE_REPLAY_RESIDUE_OK"
        $engine = [IO.Path]::Combine($working, ".slm-clipboard-transfer", ("engine-{0}.ps1" -f $plan.receiverSha256))
        $script:receiver = [scriptblock]::Create([Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($engine)))
        $chunks = @($plan.chunks)
        [Array]::Reverse($chunks)
        foreach ($chunk in $chunks) { Invoke-ProtocolFrame ([string]$chunk.frameFile) }
        if ($chunks.Count -gt 0) { Invoke-ProtocolFrame ([string]$chunks[0].frameFile) }
        Invoke-ProtocolFrame ([string]$plan.loopStatus)
        Invoke-ProtocolFrame ([string]$plan.loopFinalize)
        Invoke-ProtocolFrame ([string]$plan.loopFinalize)
        $target = [IO.Path]::Combine($working, [string]$plan.targetName)
        $item = Get-Item -LiteralPath $target -Force
        $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($item.Length -ne [long]$plan.totalLength -or $hash -cne [string]$plan.fileSha256) {
            throw "CT_WINDOWS_E2E_FINAL_INVALID"
        }
        $unexpected = [IO.Path]::Combine($working, ".slm-clipboard-transfer", [string]$plan.sessionId, "bootstrap", "unexpected.item")
        [IO.File]::WriteAllBytes($unexpected, [byte[]]@(0))
        try {
            Invoke-ProtocolFrame ([string]$plan.loopCleanup) "CT_CLEANUP_CONFLICT"
        } finally {
            Remove-Item -LiteralPath $unexpected -Force
        }
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "CT_WINDOWS_E2E_CLEANUP_CONFLICT_TOUCHED_TARGET"
        }
        Write-Output "CT_WINDOWS_CLEANUP_CONFLICT_OK"
        Invoke-ProtocolFrame ([string]$plan.loopCleanup)
        Invoke-Frame ([string]$plan.cleanup)
        Write-Output "CT_WINDOWS_E2E_OK"
    } finally {
        Pop-Location
    }
} finally {
    $workingItem = Get-Item -LiteralPath $working -Force
    if (($workingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "CT_WINDOWS_E2E_CLEANUP_REJECTED"
    }
    Remove-Item -LiteralPath $working -Recurse -Force
}
