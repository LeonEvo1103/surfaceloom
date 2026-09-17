import { gzipSync } from "node:zlib";

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const bytes = Buffer.from(entry.bytes ?? "");
    const flags = entry.flags ?? 0x800;
    const method = entry.method ?? 0;
    const declaredSize = entry.declaredSize ?? bytes.length;
    const checksum = entry.crc ?? crc32(bytes);
    const local = Buffer.alloc(30 + name.length + bytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    bytes.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.externalAttributes ?? (0o100644 << 16)) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, central, end]);
}

export function tgz(entries) {
  return gzipSync(tar(entries), { level: 6 });
}

export function tar(entries, { ustar = true } = {}) {
  const blocks = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, 100, 8, entry.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    if (entry.linkName !== undefined) header.write(entry.linkName, 157, 100, "utf8");
    if (ustar) {
      header.write("ustar\0", 257, 6, "ascii");
      header.write("00", 263, 2, "ascii");
    }
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function pe(payload = "host") {
  const content = Buffer.from(payload);
  const rawOffset = 512;
  const bytes = Buffer.alloc(rawOffset + content.length);
  bytes.write("MZ", 0, 2, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(1, 70);
  bytes.writeUInt16LE(240, 84);
  bytes.writeUInt16LE(0x2022, 86);
  bytes.writeUInt16LE(0x20b, 88);
  const section = 64 + 24 + 240;
  bytes.write(".text", section, 5, "ascii");
  bytes.writeUInt32LE(content.length, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(content.length, section + 16);
  bytes.writeUInt32LE(rawOffset, section + 20);
  bytes.writeUInt32LE(0x60000020, section + 36);
  content.copy(bytes, rawOffset);
  return bytes;
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
