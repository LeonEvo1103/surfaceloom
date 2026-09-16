import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";

export async function copyArtifactFile(
  source: string,
  destination: string,
  contentType: string,
): Promise<{ readonly sizeBytes: number; readonly sha256: string }> {
  const pathInfo = await lstat(source);
  if (!pathInfo.isFile()) throw codedError("SOURCE_NOT_REGULAR");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
  let destinationHandle: FileHandle | undefined;
  const hash = createHash("sha256");
  const header = Buffer.alloc(12);
  let headerLength = 0;
  let position = 0;
  try {
    const sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile()) throw codedError("SOURCE_NOT_REGULAR");
    if (sourceInfo.dev !== pathInfo.dev || sourceInfo.ino !== pathInfo.ino) {
      throw codedError("SOURCE_CHANGED_BEFORE_COPY");
    }
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      if (headerLength < header.length) {
        const copied = Math.min(header.length - headerLength, bytesRead);
        buffer.copy(header, headerLength, 0, copied);
        headerLength += copied;
      }
      await writeFully(destinationHandle, buffer, bytesRead, position);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== sourceInfo.size) throw codedError("SOURCE_CHANGED_DURING_COPY");
    assertMediaSignature(contentType, header.subarray(0, headerLength));
    await destinationHandle.sync();
    return Object.freeze({ sizeBytes: position, sha256: hash.digest("hex") });
  } finally {
    try {
      await destinationHandle?.close();
    } finally {
      await sourceHandle.close();
    }
  }
}

export function extensionForContentType(contentType: string): string {
  const extension: Readonly<Record<string, string>> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "application/json": ".json",
    "application/x-ndjson": ".jsonl",
    "application/zip": ".zip",
    "text/plain": ".txt",
    "text/html": ".html",
  };
  const result = extension[contentType];
  if (result === undefined) throw contentTypeMismatch(contentType);
  return result;
}

async function writeFully(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesWritten === 0) throw codedError("EVIDENCE_WRITE_STALLED");
    offset += bytesWritten;
  }
}

function assertMediaSignature(contentType: string, header: Buffer): void {
  const matches = (() => {
    switch (contentType) {
      case "image/png":
        return startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      case "image/jpeg":
        return startsWith(header, [0xff, 0xd8, 0xff]);
      case "image/webp":
        return asciiAt(header, 0, "RIFF") && asciiAt(header, 8, "WEBP");
      case "video/webm":
        return startsWith(header, [0x1a, 0x45, 0xdf, 0xa3]);
      case "video/mp4":
        return asciiAt(header, 4, "ftyp") && !asciiAt(header, 8, "qt  ");
      case "video/quicktime":
        return asciiAt(header, 4, "ftyp") && asciiAt(header, 8, "qt  ");
      default:
        return true;
    }
  })();
  if (!matches) throw contentTypeMismatch(contentType);
}

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  return buffer.length >= signature.length
    && signature.every((byte, index) => buffer[index] === byte);
}

function asciiAt(buffer: Buffer, offset: number, value: string): boolean {
  return buffer.length >= offset + value.length
    && buffer.subarray(offset, offset + value.length).toString("ascii") === value;
}

function contentTypeMismatch(contentType: string): Error & { readonly code: string } {
  return Object.assign(
    new Error(`Evidence bytes do not match declared content type ${contentType}.`),
    { code: "CONTENT_TYPE_MISMATCH" as const },
  );
}

function codedError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error("Evidence file validation failed."), { code });
}
