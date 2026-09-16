import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
  link,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  decodeCanonicalBase64,
  encodeManifest,
  expectedChunkLength,
  formatRanges,
  protocolError,
  sha256,
  STATE_DIRECTORY,
  validateSessionId,
  validateTargetName,
} from "./protocol.mjs";
import {
  assertPlain,
  chunkFileName,
  exists,
  readOptional,
  readOptionalRegular,
  withSessionLock,
} from "./reference-receiver-primitives.mjs";

export class ReferenceReceiver {
  constructor(root) {
    this.root = path.resolve(root);
  }

  async init(manifest) {
    return withSessionLock(this.#lockKey(manifest), () => this.#init(manifest));
  }

  async #init(manifest) {
    await this.#assertSafeRoot();
    validateSessionId(manifest.sessionId);
    validateTargetName(manifest.targetName);
    const paths = this.#paths(manifest);
    await this.#ensurePlainDirectory(paths.state);
    await this.#ensurePlainDirectory(paths.session);
    await this.#writeExact(paths.manifest, encodeManifest(manifest), "SESSION_CONFLICT");
    await this.#ensurePlainDirectory(paths.chunks);
    return "created-or-present";
  }

  async add(manifest, chunk) {
    return withSessionLock(this.#lockKey(manifest), () => this.#add(manifest, chunk));
  }

  async #add(manifest, chunk) {
    const paths = await this.#loadSession(manifest);
    if (chunk.index < 0 || chunk.index >= manifest.chunkCount) throw protocolError("CHUNK_INDEX_INVALID");
    const expectedLength = expectedChunkLength(manifest, chunk.index);
    const raw = decodeCanonicalBase64(chunk.base64);
    if (chunk.rawLength !== expectedLength || raw.length !== expectedLength || sha256(raw) !== chunk.sha256) {
      throw protocolError("CHUNK_INTEGRITY_FAILED");
    }
    const frame = Buffer.from(JSON.stringify({ i: chunk.index, l: chunk.rawLength, s: chunk.sha256, p: chunk.base64 }), "utf8");
    const destination = path.join(paths.chunks, chunkFileName(chunk.index));
    const existing = await readOptional(destination);
    if (existing) {
      if (!existing.equals(frame)) throw protocolError("CHUNK_CONFLICT");
      await this.#readChunk(destination, manifest, chunk.index);
      return "already-present";
    }
    await this.#atomicCreate(destination, frame);
    return "stored";
  }

  async status(manifest) {
    return withSessionLock(this.#lockKey(manifest), () => this.#status(manifest));
  }

  async #status(manifest) {
    const paths = await this.#loadSession(manifest);
    const missing = [];
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const candidate = path.join(paths.chunks, chunkFileName(index));
      if (!(await exists(candidate))) missing.push(index);
      else await this.#readChunk(candidate, manifest, index);
    }
    return { received: manifest.chunkCount - missing.length, missing, missingRanges: formatRanges(missing) };
  }

  async finalize(manifest) {
    return withSessionLock(this.#lockKey(manifest), () => this.#finalize(manifest));
  }

  async #finalize(manifest) {
    const paths = await this.#loadSession(manifest);
    const existingTarget = await readOptionalRegular(paths.target);
    if (existingTarget !== null) {
      if (existingTarget.length !== manifest.totalLength || sha256(existingTarget) !== manifest.fileSha256) {
        throw protocolError("TARGET_CONFLICT");
      }
      return "already-present";
    }
    const status = await this.#status(manifest);
    if (status.missing.length > 0) throw protocolError("CHUNKS_MISSING");
    const names = await readdir(paths.chunks);
    const expectedNames = Array.from({ length: manifest.chunkCount }, (_, index) => chunkFileName(index));
    if (JSON.stringify(names.sort()) !== JSON.stringify(expectedNames)) throw protocolError("CHUNK_SET_CONFLICT");
    const chunks = [];
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      chunks.push(await this.#readChunk(path.join(paths.chunks, chunkFileName(index)), manifest, index));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== manifest.totalLength || sha256(bytes) !== manifest.fileSha256) {
      throw protocolError("FINAL_INTEGRITY_FAILED");
    }
    if (await exists(paths.partial)) await this.#removePlainFile(paths.partial);
    await this.#atomicCreate(paths.partial, bytes);
    const reopened = await readOptionalRegular(paths.partial);
    if (!reopened || reopened.length !== manifest.totalLength || sha256(reopened) !== manifest.fileSha256) {
      throw protocolError("FINAL_INTEGRITY_FAILED");
    }
    try {
      await link(paths.partial, paths.target);
      await unlink(paths.partial);
      return "created";
    } catch (error) {
      const racedTarget = await readOptionalRegular(paths.target);
      if (racedTarget === null || racedTarget.length !== manifest.totalLength || sha256(racedTarget) !== manifest.fileSha256) {
        throw protocolError("TARGET_CONFLICT");
      }
      await rm(paths.partial, { force: true });
      return "already-present";
    }
  }

  async cleanup(manifest) {
    return withSessionLock(this.#lockKey(manifest), () => this.#cleanup(manifest));
  }

  async #cleanup(manifest) {
    await this.#loadSession(manifest);
    const paths = this.#paths(manifest);
    if (await exists(paths.partial)) await this.#removePlainFile(paths.partial);
    const sessionEntries = (await readdir(paths.session, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sessionEntries) {
      if (entry.isSymbolicLink()) throw protocolError("REPARSE_REJECTED");
      if (entry.name === "manifest.json" && entry.isFile()) continue;
      if (entry.name === "chunks" && entry.isDirectory()) continue;
      throw protocolError("CLEANUP_CONFLICT");
    }
    for (const entry of await readdir(paths.chunks, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d{8}\.chunk\.json$/u.test(entry.name)) throw protocolError("CLEANUP_CONFLICT");
    }
    await rm(paths.chunks, { recursive: true });
    await unlink(paths.manifest);
    await rmdir(paths.session);
    return "removed";
  }

  #paths(manifest) {
    const state = path.join(this.root, STATE_DIRECTORY);
    const session = path.join(state, manifest.sessionId);
    const target = path.resolve(this.root, manifest.targetName);
    if (path.dirname(target) !== this.root) throw protocolError("PATH_REJECTED");
    return {
      state,
      session,
      manifest: path.join(session, "manifest.json"),
      chunks: path.join(session, "chunks"),
      target,
      partial: path.join(this.root, `.slm-clipboard-${manifest.sessionId}.partial`),
    };
  }

  #lockKey(manifest) { return `${this.root}|${manifest.sessionId}`; }

  async #loadSession(manifest) {
    await this.#assertSafeRoot();
    const paths = this.#paths(manifest);
    await assertPlain(paths.state, true);
    await assertPlain(paths.session, true);
    await assertPlain(paths.manifest, false);
    await assertPlain(paths.chunks, true);
    const actual = await readFile(paths.manifest);
    if (!actual.equals(encodeManifest(manifest))) throw protocolError("SESSION_CONFLICT");
    return paths;
  }

  async #readChunk(file, manifest, index) {
    await assertPlain(file, false);
    const text = (await readFile(file)).toString("utf8");
    let frame;
    try { frame = JSON.parse(text); } catch { throw protocolError("CHUNK_CORRUPT"); }
    if (JSON.stringify(frame) !== text || JSON.stringify(Object.keys(frame)) !== JSON.stringify(["i", "l", "s", "p"])) {
      throw protocolError("CHUNK_CORRUPT");
    }
    const raw = decodeCanonicalBase64(frame.p);
    if (frame.i !== index || frame.l !== expectedChunkLength(manifest, index) || raw.length !== frame.l || sha256(raw) !== frame.s) {
      throw protocolError("CHUNK_CORRUPT");
    }
    return raw;
  }

  async #assertSafeRoot() {
    await assertPlain(this.root, true);
    let current = this.root;
    while (path.dirname(current) !== current) {
      await assertPlain(current, true);
      current = path.dirname(current);
    }
  }

  async #ensurePlainDirectory(directory) {
    if (await exists(directory)) await assertPlain(directory, true);
    else await mkdir(directory);
  }

  async #writeExact(destination, bytes, conflictCode) {
    const existing = await readOptional(destination);
    if (existing) {
      if (!existing.equals(bytes)) throw protocolError(conflictCode);
      return;
    }
    await this.#atomicCreate(destination, bytes);
  }

  async #atomicCreate(destination, bytes) {
    const temporary = path.join(path.dirname(destination), `.tmp-${randomUUID().replaceAll("-", "")}`);
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, destination); } finally { await rm(temporary, { force: true }); }
  }

  async #removePlainFile(file) {
    await assertPlain(file, false);
    await unlink(file);
  }
}
