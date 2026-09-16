[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Outbox,

    [switch]$IncludeSources
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$outboxPath = (Resolve-Path -LiteralPath $Outbox -ErrorAction Stop).ProviderPath
$commandsPath = Join-Path $outboxPath "commands"
if (-not (Test-Path -LiteralPath $commandsPath -PathType Container)) {
    throw "CT_AST_OUTBOX_INVALID"
}

$outboxFiles = @(
    Get-ChildItem -LiteralPath $commandsPath -Recurse -Force |
        Where-Object {
            -not $_.PSIsContainer -and
            $_.Name.EndsWith(".ps1.txt", [StringComparison]::OrdinalIgnoreCase)
        } |
        Sort-Object FullName
)
if ($outboxFiles.Count -eq 0) {
    throw "CT_AST_OUTBOX_EMPTY"
}

$files = @($outboxFiles)
if ($IncludeSources) {
    $files += Get-Item -LiteralPath (Join-Path $PSScriptRoot "powershell/receiver.ps1") -Force
    $files += Get-Item -LiteralPath (Join-Path $PSScriptRoot "test-windows-e2e.ps1") -Force
}

$errorCount = 0
foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$parseErrors
    )
    foreach ($parseError in @($parseErrors)) {
        $errorCount += 1
        Write-Output ("CT_AST_ERROR FILE={0} ERROR_ID={1} LINE={2} COLUMN={3}" -f
            $file.Name,
            $parseError.ErrorId,
            $parseError.Extent.StartLineNumber,
            $parseError.Extent.StartColumnNumber)
    }
}

if ($errorCount -ne 0) {
    throw ("CT_AST_PARSE_FAILED COUNT={0}" -f $errorCount)
}

Write-Output ("CT_AST_OK OUTBOX_FILES={0} SOURCE_FILES={1}" -f
    $outboxFiles.Count,
    ($files.Count - $outboxFiles.Count))
