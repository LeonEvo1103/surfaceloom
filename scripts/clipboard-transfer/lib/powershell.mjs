import {
  canonicalBase64,
  encodeManifest,
  sha256,
  STATE_DIRECTORY,
} from "./protocol.mjs";
import {
  compressedEngine,
  compressedEngineHash,
  engineFileName,
  engineHash,
  engineManifestBytes,
  engineManifestHash,
  engineParts,
} from "./powershell-engine.mjs";
import {
  commonRootGuard,
  compressedCommand,
  directoryChainGuard,
  itemGuard,
  safeCommand,
  stateSessionGuard,
  writeExactFunction,
} from "./powershell-guards.mjs";
export function buildInitCommands(manifest) {
  const manifestBytes = encodeManifest(manifest);
  const manifestHash = sha256(manifestBytes);
  const manifestBase64 = canonicalBase64(manifestBytes);
  const prepareBody = [
    stateSessionGuard(manifest.sessionId, manifest.targetName.length),
    `$global:LASTEXITCODE=0;Write-Output 'CT_INIT_PREPARE_OK SESSION=${manifest.sessionId}'`,
  ].join(";");
  const startManifestBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}')`,
    directoryChainGuard("$d", "$s"),
    writeExactFunction(),
    "$p=[IO.Path]::Combine($s,'manifest.json')",
    `$m=[Convert]::FromBase64String('${manifestBase64}')`,
    `w $p $m '${manifestHash}'`,
    "$global:LASTEXITCODE=0;'CT_INIT_MANIFEST_OK'",
  ].join(";");
  const prepareEngineBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}')`,
    directoryChainGuard("$d", "$s"),
    "$b=[IO.Path]::Combine($s,'bootstrap');if(Test-Path -LiteralPath $b){$i=Get-Item -LiteralPath $b -Force;if(($i.Attributes-band$rp)-ne0-or-not$i.PSIsContainer){$c='CT_SESSION_CONFLICT';throw}}else{[void][IO.Directory]::CreateDirectory($b)}",
    `$global:LASTEXITCODE=0;Write-Output 'CT_INIT_BOOTSTRAP_OK SESSION=${manifest.sessionId}'`,
  ].join(";");
  const startEngineBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}');$b=[IO.Path]::Combine($s,'bootstrap')`,
    directoryChainGuard("$d", "$s", "$b"),
    writeExactFunction(),
    "$p=[IO.Path]::Combine($b,'engine-manifest.json')",
    `$m=[Convert]::FromBase64String('${canonicalBase64(engineManifestBytes)}')`,
    `w $p $m '${engineManifestHash}'`,
    "$global:LASTEXITCODE=0;Write-Output 'CT_INIT_STAGE'",
  ].join(";");

  const partCommands = engineParts.map((part) => {
    const body = [
      commonRootGuard(),
      `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}');$b=[IO.Path]::Combine($s,'bootstrap')`,
      directoryChainGuard("$d", "$s", "$b"),
      writeExactFunction(),
      `$p=[IO.Path]::Combine($b,'${String(part.index).padStart(4, "0")}.part')`,
      `$x=[Convert]::FromBase64String('${part.base64}')`,
      `if($x.Length-ne${part.rawLength}){$c='CT_INIT_INTEGRITY_FAILED';throw};w $p $x '${part.sha256}'`,
      `$global:LASTEXITCODE=0;Write-Output 'CT_INIT_PART_OK SESSION=${manifest.sessionId} INDEX=${part.index}'`,
    ].join(";");
    return safeCommand(body, false);
  });

  const inventoryBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}');$b=[IO.Path]::Combine($s,'bootstrap')`,
    directoryChainGuard("$d", "$s", "$b"),
    "$p=[IO.Path]::Combine($b,'engine-manifest.json')",
    itemGuard("$p", false, "CT_INIT_INCOMPLETE"),
    `if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()-cne'${engineManifestHash}'){$c='CT_INIT_INV_MANIFEST_HASH';throw}`,
    "$c='CT_INIT_INV_ENUM';$f=@(Get-ChildItem -LiteralPath $b -Force)",
    `if(@($f|Where-Object {$_.Name-match'^\\d{4}\\.part$'}).Count-ne${engineParts.length}){$c='CT_INIT_INV_PART_COUNT';throw};foreach($i in $f){if($i.PSIsContainer-or($i.Attributes-band$rp)-ne0-or$i.Name-cnotmatch'^(?:engine-manifest\\.json|engine\\.(?:gz(?:\\.work)?|raw\\.work)|\\d{4}\\.part)$'){$c='CT_INIT_INV_ITEM';throw}}`,
    `$global:LASTEXITCODE=0;Write-Output 'CT_INIT_INVENTORY_OK SESSION=${manifest.sessionId}'`,
  ].join(";");

  const recoverBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}');$b=[IO.Path]::Combine($s,'bootstrap')`,
    directoryChainGuard("$d", "$s", "$b"),
    "foreach($v in @($s,$b)){foreach($i in Get-ChildItem -LiteralPath $v -Force){if($i.Name-match'^\\.tmp-[a-f0-9]{32}$'){if($i.PSIsContainer-or($i.Attributes-band$rp)-ne0){$c='CT_REPARSE_REJECTED';throw};Remove-Item -LiteralPath $i.FullName -Force}}}",
    `$global:LASTEXITCODE=0;Write-Output 'CT_INIT_RECOVERY_OK SESSION=${manifest.sessionId}'`,
  ].join(";");

  const assembleBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}');$b=[IO.Path]::Combine($s,'bootstrap')`,
    directoryChainGuard("$d", "$s", "$b"),
    "$g=[IO.Path]::Combine($b,'engine.gz.work');if(Test-Path -LiteralPath $g){" + itemGuard("$g", false, "CT_INIT_CONFLICT") + ";Remove-Item -LiteralPath $g -Force}",
    `$a=[IO.MemoryStream]::new();try{for($j=0;$j-lt${engineParts.length};$j++){$p=[IO.Path]::Combine($b,('{0:D4}.part'-f$j));$i=Get-Item -LiteralPath $p -Force;if($i.PSIsContainer-or($i.Attributes-band$rp)-ne0){$c='CT_INIT_CONFLICT';throw};$x=[IO.File]::ReadAllBytes($p);$a.Write($x,0,$x.Length)};$z=$a.ToArray()}finally{$a.Dispose()}`,
    "[IO.File]::WriteAllBytes($g,$z)",
    "$global:LASTEXITCODE=0;Write-Output 'CT_INIT_ASSEMBLE_OK'",
  ].join(";");

  const publishCompressedBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}');$b=[IO.Path]::Combine($s,'bootstrap')`,
    directoryChainGuard("$d", "$s", "$b"),
    "$p=[IO.Path]::Combine($b,'engine.gz.work');$g=[IO.Path]::Combine($b,'engine.gz')",
    `if(Test-Path -LiteralPath $g){${itemGuard("$g", false, "CT_INIT_CONFLICT")};if((Get-Item -LiteralPath $g).Length-ne${compressedEngine.length}-or(Get-FileHash -LiteralPath $g -Algorithm SHA256).Hash.ToLower()-cne'${compressedEngineHash}'){$c='CT_INIT_CONFLICT';throw}}else{`,
    itemGuard("$p", false, "CT_INIT_INCOMPLETE"),
    `if((Get-Item -LiteralPath $p).Length-ne${compressedEngine.length}-or(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()-cne'${compressedEngineHash}'){$c='CT_INIT_CONFLICT';throw};[IO.File]::Move($p,$g)}`,
    "$global:LASTEXITCODE=0;Write-Output 'CT_INIT_GZIP_OK'",
  ].join(";");

  const inflateEngineBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}');$b=[IO.Path]::Combine($s,'bootstrap')`,
    directoryChainGuard("$d", "$s", "$b"),
    "$g=[IO.Path]::Combine($b,'engine.gz');$e=[IO.Path]::Combine($b,'engine.raw.work')",
    itemGuard("$g", false, "CT_INIT_INCOMPLETE"),
    `if(Test-Path -LiteralPath $e){${itemGuard("$e", false, "CT_ENGINE_CONFLICT")};Remove-Item -LiteralPath $e -Force}`,
    "$z=[IO.File]::ReadAllBytes($g);$a=[IO.MemoryStream]::new([byte[]]$z);$q=[IO.Compression.GZipStream]::new($a,[IO.Compression.CompressionMode]::Decompress);$o=[IO.MemoryStream]::new();try{$q.CopyTo($o);$x=$o.ToArray()}finally{$q.Dispose();$a.Dispose();$o.Dispose()}",
    "[IO.File]::WriteAllBytes($e,$x)",
    "$global:LASTEXITCODE=0;Write-Output 'CT_INIT_INFLATE_OK'",
  ].join(";");

  const publishEngineBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}');$b=[IO.Path]::Combine($s,'bootstrap')`,
    directoryChainGuard("$d", "$s", "$b"),
    `$p=[IO.Path]::Combine($b,'engine.raw.work');$e=[IO.Path]::Combine($d,'${engineFileName}')`,
    `if(Test-Path -LiteralPath $e){${itemGuard("$e", false, "CT_ENGINE_CONFLICT")};if((Get-FileHash -LiteralPath $e -Algorithm SHA256).Hash.ToLower()-cne'${engineHash}'){$c='CT_ENGINE_CONFLICT';throw}}else{`,
    itemGuard("$p", false, "CT_INIT_INCOMPLETE"),
    `if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()-cne'${engineHash}'){$c='CT_ENGINE_CONFLICT';throw};[IO.File]::Move($p,$e)}`,
    "$global:LASTEXITCODE=0;Write-Output 'CT_INIT_ENGINE_OK'",
  ].join(";");

  const readyBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}')`,
    directoryChainGuard("$d", "$s"),
    "$p=[IO.Path]::Combine($s,'manifest.json')",
    itemGuard("$p", false, "CT_SESSION_MISSING"),
    `if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()-cne'${manifestHash}'){$c='CT_SESSION_CONFLICT';throw}`,
    `$e=[IO.Path]::Combine($d,'${engineFileName}')`,
    itemGuard("$e", false, "CT_ENGINE_MISSING"),
    `if((Get-FileHash -LiteralPath $e -Algorithm SHA256).Hash.ToLowerInvariant()-cne'${engineHash}'){$c='CT_ENGINE_CONFLICT';throw}`,
    `$global:LASTEXITCODE=0;Write-Output 'CT_INIT_OK SESSION=${manifest.sessionId}'`,
  ].join(";");

  const chunksBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}')`,
    directoryChainGuard("$d", "$s"),
    "$k=[IO.Path]::Combine($s,'chunks');if(Test-Path -LiteralPath $k){$i=Get-Item -LiteralPath $k -Force;if(($i.Attributes-band$rp)-ne0-or-not$i.PSIsContainer){$c='CT_SESSION_CONFLICT';throw}}else{[void][IO.Directory]::CreateDirectory($k)}",
    "$global:LASTEXITCODE=0;Write-Output 'CT_INIT_CHUNKS_OK'",
  ].join(";");

  const abortInitBody = [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}');$s=[IO.Path]::Combine($d,'${manifest.sessionId}')`,
    directoryChainGuard("$d", "$s"),
    "$p=[IO.Path]::Combine($s,'manifest.json')",
    `if(Test-Path -LiteralPath $p){${itemGuard("$p", false, "CT_INIT_ABORT_CONFLICT")};if((Get-FileHash -LiteralPath $p).Hash.ToLower()-cne'${manifestHash}'){$c='CT_SESSION_CONFLICT';throw}}`,
    "$f=@(Get-ChildItem -LiteralPath $s -Force);foreach($i in $f){if(($i.Attributes-band$rp)-ne0){$c='CT_REPARSE_REJECTED';throw};if(($i.Name-eq'manifest.json'-and-not$i.PSIsContainer)-or($i.Name-eq'bootstrap'-and$i.PSIsContainer)-or($i.Name-match'^\\.tmp-[a-f0-9]{32}$'-and-not$i.PSIsContainer)){continue};$c='CT_INIT_ABORT_CONFLICT';throw}",
    "$b=[IO.Path]::Combine($s,'bootstrap');if(Test-Path -LiteralPath $b){foreach($i in Get-ChildItem -LiteralPath $b -Force){if($i.PSIsContainer-or($i.Attributes-band$rp)-ne0-or$i.Name-cnotmatch'^(?:engine-manifest\\.json|engine\\.(?:gz(?:\\.work)?|raw\\.work)|\\d{4}\\.part|\\.tmp-[a-f0-9]{32})$'){$c='CT_INIT_ABORT_CONFLICT';throw};Remove-Item -LiteralPath $i.FullName -Force};Remove-Item -LiteralPath $b -Force}",
    "foreach($i in Get-ChildItem -LiteralPath $s -Force){if($i.Name-match'^\\.tmp-'){Remove-Item -LiteralPath $i.FullName -Force}};if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force};Remove-Item -LiteralPath $s -Force",
    `$global:LASTEXITCODE=0;Write-Output 'CT_INIT_ABORT_OK SESSION=${manifest.sessionId}'`,
  ].join(";");

  return {
    commands: [
      safeCommand(prepareBody),
      safeCommand(startManifestBody, false),
      safeCommand(prepareEngineBody, false),
      safeCommand(startEngineBody, false),
      ...partCommands,
      safeCommand(recoverBody, false),
      compressedCommand(
        inventoryBody,
        "CT_INIT_INV_FRAME_INVALID",
        `CT_INIT_INVENTORY_OK SESSION=${manifest.sessionId}`,
      ),
      safeCommand(assembleBody, false),
      safeCommand(publishCompressedBody, false),
      safeCommand(inflateEngineBody, false),
      safeCommand(publishEngineBody, false),
      safeCommand(chunksBody, false),
      safeCommand(readyBody, false),
    ],
    manifestHash,
    engineHash,
    abortInit: compressedCommand(abortInitBody, "CT_ABORT_FRAME_INVALID"),
  };
}

function invocationPrefix() {
  return [
    commonRootGuard(),
    `$d=[IO.Path]::Combine($r,'${STATE_DIRECTORY}')`,
    `$e=[IO.Path]::Combine($d,'${engineFileName}')`,
    itemGuard("$d", true, "CT_ENGINE_MISSING"),
    itemGuard("$e", false, "CT_ENGINE_MISSING"),
    `if((Get-FileHash -LiteralPath $e -Algorithm SHA256).Hash.ToLowerInvariant()-cne'${engineHash}'){$c='CT_ENGINE_CONFLICT';throw}`,
    "$u=[Text.UTF8Encoding]::new($false,$true)",
    "$b=[scriptblock]::Create($u.GetString([IO.File]::ReadAllBytes($e)))",
  ].join(";");
}

function invokeCommand(action, manifest, manifestHash, extra = "") {
  const invocation = [
    invocationPrefix(),
    `& $b -Action '${action}' -SessionId '${manifest.sessionId}' -ManifestHash '${manifestHash}'${extra}`,
  ].join(";");
  return safeCommand(invocation);
}

export function buildChunkCommand(manifest, manifestHash, chunk) {
  const extra = ` -Index ${chunk.index} -RawLength ${chunk.rawLength} -ChunkHash '${chunk.sha256}' -Payload '${chunk.base64}'`;
  return invokeCommand("Chunk", manifest, manifestHash, extra);
}

export function buildDataFrame(manifest, chunk) {
  return `SLMCT1|C|${manifest.sessionId}|${chunk.index}|${chunk.rawLength}|${chunk.sha256}|${chunk.base64}`;
}

export function buildLoopFrames(manifest) {
  const prefix = `SLMCT1|`;
  const suffix = `|${manifest.sessionId}`;
  return {
    loopStatus: `${prefix}S${suffix}`,
    loopFinalize: `${prefix}F${suffix}`,
    loopQuit: `${prefix}Q${suffix}`,
    loopCleanup: `${prefix}X${suffix}`,
  };
}

export function buildControlCommands(manifest, manifestHash) {
  return {
    receiveLoop: invokeCommand("Loop", manifest, manifestHash),
    status: invokeCommand("Status", manifest, manifestHash),
    finalize: invokeCommand("Finalize", manifest, manifestHash),
    cleanup: invokeCommand("Cleanup", manifest, manifestHash),
  };
}

export function receiverMetadata() {
  return { engineHash, engineFileName, compressedBytes: compressedEngine.length };
}
