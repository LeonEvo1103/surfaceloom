import { gzipSync } from "node:zlib";

import { canonicalBase64, STATE_DIRECTORY } from "./protocol.mjs";

const MAX_WORKING_ROOT_CHARS = 120;
const MAX_FULL_PATH_CHARS = 240;

function historyGuard() {
  return "$q=Get-Command Set-PSReadLineOption -ea 0;if($q){Set-PSReadLineOption -HistorySaveStyle SaveNothing}";
}

export function commonRootGuard() {
  return [
    "$l=Get-Location",
    "if($l.Provider.Name-cne'FileSystem'){$c='CT_PATH_REJECTED';throw}",
    "$r=[IO.Path]::GetFullPath($l.ProviderPath)",
    "$i=Get-Item -LiteralPath $r -Force",
    "while($null-ne$i){if(($i.Attributes-band$rp)-ne0){$c='CT_REPARSE_REJECTED';throw};$i=$i.Parent}",
  ].join(";");
}

export function safeCommand(body, includeHistoryGuard = true) {
  return `&{${[
    "$ErrorActionPreference='Stop'",
    "$c='CT_INTERNAL_ERROR'",
    "$rp=[IO.FileAttributes]::ReparsePoint",
    "try{",
    includeHistoryGuard ? historyGuard() : "",
    body,
    "}catch{Write-Output ('CT_ERROR '+$c);$global:LASTEXITCODE=1}",
  ].join(";")}}`;
}

export function compressedCommand(body, errorCode, marker = "") {
  const compressed = gzipSync(Buffer.from(safeCommand(body, false), "utf8"), { level: 9 });
  const markerAssignment = marker ? `;$null='${marker}'` : "";
  return `&{$ErrorActionPreference='Stop';try{$z=[Convert]::FromBase64String('${canonicalBase64(compressed)}');$a=[IO.MemoryStream]::new([byte[]]$z);$g=[IO.Compression.GZipStream]::new($a,[IO.Compression.CompressionMode]::Decompress);$o=[IO.MemoryStream]::new();try{$g.CopyTo($o);$x=$o.ToArray()}finally{$g.Dispose();$a.Dispose();$o.Dispose()};&([scriptblock]::Create([Text.Encoding]::UTF8.GetString($x)))}catch{Write-Output 'CT_ERROR ${errorCode}';$global:LASTEXITCODE=1}${markerAssignment}}`;
}

export function itemGuard(pathVariable, directory, errorCode) {
  const containerCheck = directory ? "-not$i.PSIsContainer" : "$i.PSIsContainer";
  return [
    `if(-not(Test-Path -LiteralPath ${pathVariable})){$c='${errorCode}';throw}`,
    `$i=Get-Item -LiteralPath ${pathVariable} -Force`,
    `if(($i.Attributes-band$rp)-ne0-or${containerCheck}){$c='CT_REPARSE_REJECTED';throw}`,
  ].join(";");
}

export function directoryChainGuard(...variables) {
  return `$c='CT_SESSION_MISSING';foreach($v in @(${variables.join(",")})){$i=Get-Item -LiteralPath $v -Force;if(-not$i.PSIsContainer-or($i.Attributes-band$rp)-ne0){$c='CT_REPARSE_REJECTED';throw}}`;
}

function pathBudgetGuard(targetNameLength) {
  return [
    `$x=Get-Location;if($x.Provider.Name-ceq'FileSystem'-and($x.ProviderPath.Length-gt${MAX_WORKING_ROOT_CHARS}-or($x.ProviderPath.Length+1+${targetNameLength})-gt${MAX_FULL_PATH_CHARS})){$c='CT_PATH_TOO_LONG';throw}`,
    `if($r.Length-gt${MAX_WORKING_ROOT_CHARS}-or($r.Length+1+${targetNameLength})-gt${MAX_FULL_PATH_CHARS}){$c='CT_PATH_TOO_LONG';throw}`,
  ].join(";");
}

export function stateSessionGuard(sessionId, targetNameLength) {
  return [
    `$x=Get-Location;if($x.Provider.Name-ceq'FileSystem'-and$x.ProviderPath.Length-gt${MAX_WORKING_ROOT_CHARS}){$c='CT_PATH_TOO_LONG';throw}`,
    commonRootGuard(),
    pathBudgetGuard(targetNameLength),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}')`,
    "if(Test-Path -LiteralPath $d){$i=Get-Item -LiteralPath $d -Force;if(($i.Attributes-band$rp)-ne0-or-not$i.PSIsContainer){$c='CT_REPARSE_REJECTED';throw}}else{[void][IO.Directory]::CreateDirectory($d)}",
    `$s=[IO.Path]::Combine($d,'${sessionId}')`,
    "if(Test-Path -LiteralPath $s){$i=Get-Item -LiteralPath $s -Force;if(($i.Attributes-band$rp)-ne0-or-not$i.PSIsContainer){$c='CT_SESSION_CONFLICT';throw}}else{[void][IO.Directory]::CreateDirectory($s)}",
  ].join(";");
}

export function writeExactFunction() {
  return "function w($p,$x,$h){if(Test-Path -LiteralPath $p){$j=Get-Item -LiteralPath $p -Force;if(($j.Attributes-band$rp)-ne0-or$j.PSIsContainer-or(Get-FileHash -LiteralPath $p).Hash.ToLower()-cne$h){$script:c='CT_SESSION_CONFLICT';throw};return};$t=[IO.Path]::Combine((Split-Path -Parent $p),('.tmp-'+[Guid]::NewGuid().ToString('N')));try{[IO.File]::WriteAllBytes($t,$x);if((Get-FileHash -LiteralPath $t).Hash.ToLower()-cne$h){$script:c='CT_INIT_INTEGRITY_FAILED';throw};[IO.File]::Move($t,$p)}finally{if(Test-Path -LiteralPath $t){Remove-Item -LiteralPath $t -Force}}}";
}
