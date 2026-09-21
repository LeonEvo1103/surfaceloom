import { digestRecord, sameDigest } from "./digest.mjs";
import { digest, fail, integer, list, record, string } from "./shape.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const trustedProjectLicenses = Object.freeze([
  Object.freeze({ byteLength: 1081,
    digest: "a85611811148e50bc64026e3742e744eda23aea468d5732ca29c75ef416273e4" }),
]);
const trustedDependencyLicenses = new Map([
  ["playwright-core@1.63.0", Object.freeze({ license: "Apache-2.0", byteLength: 11601,
    digest: "45873d00a0dd243596deb4aa23b2493b3d1f0671921bf2538ea431d7380220eb" })],
  ["@modelcontextprotocol/node@2.0.0", Object.freeze({ license: "MIT", byteLength: 12227,
    digest: "0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a" })],
  ["@modelcontextprotocol/server@2.0.0", Object.freeze({ license: "MIT", byteLength: 12227,
    digest: "0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a" })],
  ["zod@4.6.5", Object.freeze({ license: "MIT", byteLength: 1072,
    digest: "3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8" })],
]);

export function validateLicenseEvidence(licenseBytes, noticeBytes, context) {
  for (const bytes of licenseBytes) {
    const actual = digestRecord(bytes);
    if (!trustedProjectLicenses.some((entry) => entry.byteLength === bytes.length
        && entry.digest === actual.value)) {
      fail("licenseEvidence", "Project license bytes are not a trusted complete license text.");
    }
  }
  const notices = new Map();
  for (const [fileIndex, bytes] of noticeBytes.entries()) {
    let document;
    try { document = parseStrictJson(utf8(bytes, `noticeFiles[${fileIndex}]`)); }
    catch { fail("noticeEvidence", `noticeFiles[${fileIndex}] must be strict JSON.`); }
    const value = record(document, `noticeFiles[${fileIndex}]`, ["schemaVersion", "components"]);
    if (value.schemaVersion !== "surfaceloom.third-party-notices/1") {
      fail("noticeEvidence", "Third-party notice schemaVersion is unsupported.");
    }
    for (const [index, input] of list(value.components,
      `noticeFiles[${fileIndex}].components`, { min: 1 }).entries()) {
      const item = record(input, `notice component ${index}`,
        ["name", "version", "license", "licenseText", "licenseTextByteLength", "licenseTextDigest"]);
      const name = string(item.name, "notice component name");
      if (notices.has(name)) fail("noticeEvidence", `Duplicate notice component ${name}.`);
      const licenseText = string(item.licenseText, `${name} notice licenseText`);
      const licenseTextBytes = Buffer.from(licenseText, "utf8");
      const byteLength = integer(item.licenseTextByteLength, `${name} notice licenseTextByteLength`, { min: 1 });
      const declaredDigest = digest(item.licenseTextDigest, `${name} notice licenseTextDigest`);
      const actualDigest = digestRecord(licenseTextBytes);
      if (byteLength !== licenseTextBytes.length || !sameDigest(declaredDigest, actualDigest)) {
        fail("noticeEvidence", `NOTICE license text bytes for ${name} do not match their digest.`);
      }
      notices.set(name, {
        version: string(item.version, `${name} notice version`),
        license: string(item.license, `${name} notice license`),
        byteLength, digest: actualDigest.value,
      });
    }
  }
  if (notices.size !== context.externalDependencies.size) {
    fail("noticeEvidence", "NOTICE components do not exactly cover external dependencies.");
  }
  for (const name of context.externalDependencies) {
    const notice = notices.get(name);
    const sbom = context.sbomDependencies.get(name);
    const trusted = notice === undefined ? undefined
      : trustedDependencyLicenses.get(`${name}@${notice.version}`);
    if (notice === undefined || sbom === undefined || notice.version !== sbom.version
        || notice.license !== sbom.license || trusted === undefined
        || trusted.license !== notice.license || trusted.byteLength !== notice.byteLength
        || trusted.digest !== notice.digest) {
      fail("noticeEvidence", `NOTICE evidence for ${name} does not match its SBOM/license bytes.`);
    }
  }
}

function utf8(bytes, label) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("complianceEvidence", `${label} must be UTF-8 text.`); }
}
