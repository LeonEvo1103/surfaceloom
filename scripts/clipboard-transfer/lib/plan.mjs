import {
  buildManifest,
  createSessionId,
  DEFAULT_CHUNK_RAW_BYTES,
  DEFAULT_MAX_COMMAND_CHARS,
  protocolError,
  splitChunks,
  validateSessionId,
  validateTargetName,
} from "./protocol.mjs";
import {
  buildDataFrame,
  buildControlCommands,
  buildInitCommands,
  buildLoopFrames,
  receiverMetadata,
} from "./powershell.mjs";

const MIN_COMMAND_LIMIT = 1_024;
const MAX_COMMAND_LIMIT = 32_768;

export function prepareTransfer({
  bytes,
  targetName,
  sessionId = createSessionId(),
  chunkRawBytes = DEFAULT_CHUNK_RAW_BYTES,
  maxCommandChars = DEFAULT_MAX_COMMAND_CHARS,
}) {
  if (!Buffer.isBuffer(bytes)) throw protocolError("INVALID_INPUT");
  validateTargetName(targetName);
  validateSessionId(sessionId);
  if (!Number.isSafeInteger(maxCommandChars) || maxCommandChars < MIN_COMMAND_LIMIT || maxCommandChars > MAX_COMMAND_LIMIT) {
    throw protocolError("INVALID_COMMAND_LIMIT");
  }
  if (!Number.isSafeInteger(chunkRawBytes) || chunkRawBytes < 1) {
    throw protocolError("INVALID_CHUNK_SIZE");
  }

  let candidateSize = chunkRawBytes;
  while (candidateSize >= 1) {
    const manifest = buildManifest({ sessionId, targetName, bytes, chunkRawBytes: candidateSize });
    const init = buildInitCommands(manifest);
    const chunks = splitChunks(bytes, manifest).map((chunk) => ({
      ...chunk,
      frame: buildDataFrame(manifest, chunk),
    }));
    const control = buildControlCommands(manifest, init.manifestHash);
    const loopFrames = buildLoopFrames(manifest);
    const frames = [...init.commands, init.abortInit, ...chunks.map((chunk) => chunk.frame), ...Object.values(control), ...Object.values(loopFrames)];
    frames.forEach(assertPasteFrame);
    const longest = Math.max(...frames.map((frame) => frame.length));
    if (longest <= maxCommandChars) {
      return {
        manifest,
        manifestHash: init.manifestHash,
        receiver: receiverMetadata(),
        maxCommandChars,
        longestCommandChars: longest,
        initCommands: init.commands,
        abortInit: init.abortInit,
        chunks,
        ...control,
        ...loopFrames,
      };
    }
    const fixedLongest = Math.max(init.abortInit.length, ...init.commands.map((command) => command.length), ...Object.values(control).map((command) => command.length));
    if (fixedLongest > maxCommandChars) throw protocolError("COMMAND_LIMIT_TOO_SMALL");
    const overflow = longest - maxCommandChars;
    candidateSize -= Math.max(1, Math.ceil((overflow * 3) / 4));
  }
  throw protocolError("COMMAND_LIMIT_TOO_SMALL");
}

export function assertPasteFrame(command) {
  if (typeof command !== "string" || command.length === 0 || /[^\x20-\x7e]/u.test(command)) {
    throw protocolError("UNSAFE_COMMAND_FRAME");
  }
  if (/\r|\n|\0/u.test(command)) throw protocolError("UNSAFE_COMMAND_FRAME");
  return command;
}
