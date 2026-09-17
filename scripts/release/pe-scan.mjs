import { assertReleaseContent } from "./archive-path.mjs";
import { fail } from "./shape.mjs";

const machines = new Set([0x014c, 0x8664, 0xaa64]);

export function validatePortableExecutable(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 96 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    fail("invalidPe", "PE artifact is smaller than a valid DOS/PE header.");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 24 > bytes.length
      || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    fail("invalidPe", "PE signature or e_lfanew is invalid.");
  }
  const coff = peOffset + 4;
  const machine = bytes.readUInt16LE(coff);
  const sections = bytes.readUInt16LE(coff + 2);
  const optionalSize = bytes.readUInt16LE(coff + 16);
  if (!machines.has(machine) || sections < 1 || sections > 96) {
    fail("invalidPe", "PE COFF header is unsupported or incomplete.");
  }
  const optional = coff + 20;
  const sectionTable = optional + optionalSize;
  if (sectionTable + sections * 40 > bytes.length) fail("invalidPe", "PE section table is truncated.");
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) fail("invalidPe", "PE optional header magic is invalid.");
  const minimumOptionalSize = magic === 0x10b ? 224 : 240;
  if (optionalSize < minimumOptionalSize) {
    fail("invalidPe", "PE optional header is smaller than its standard structure.");
  }
  const ranges = [];
  for (let index = 0; index < sections; index += 1) {
    const header = sectionTable + index * 40;
    const size = bytes.readUInt32LE(header + 16);
    const offset = bytes.readUInt32LE(header + 20);
    if (size === 0) continue;
    if (offset < sectionTable + sections * 40 || offset + size > bytes.length) {
      fail("invalidPe", "PE section raw-data range is invalid.");
    }
    if (ranges.some(([start, end]) => offset < end && offset + size > start)) {
      fail("invalidPe", "PE raw-data sections overlap.");
    }
    ranges.push([offset, offset + size]);
  }
  if (ranges.length === 0) fail("invalidPe", "PE artifact has no materialized section bytes.");
  assertReleaseContent("$self", bytes);
}
