import { safeArchivePath } from "./archive-path.mjs";
import {
  hostArchitectures, hostOperatingSystems, releasePipeline, strictSemverPattern,
} from "./constants.mjs";
import { digest, fail, integer, list, oneOf, record, sameJson, string, uniqueStrings } from "./shape.mjs";

export function validateProtocols(value, label = "protocols") {
  const fields = ["npm", "wire", "report", "trace", "component", "nativeHost"];
  const item = record(value, label, fields);
  for (const field of fields) string(item[field], `${label}.${field}`);
  if (item.npm !== "npm-package/1"
      || item.wire !== "surfaceloom.native/1.0"
      || item.report !== "surfaceloom.report/v3"
      || item.trace !== "surfaceloom.agent-loop/v1"
      || item.component !== "surfaceloom.component-catalog/1"
      || !strictSemverPattern.test(item.nativeHost)) {
    fail("protocolVersion", "Release protocol versions do not match the frozen compatibility contract.");
  }
  return item;
}

export function validateTargets(value) {
  const targets = list(value, "targets", { min: 1 });
  const ids = new Set();
  for (const [index, value] of targets.entries()) {
    const label = `targets[${index}]`;
    const item = record(value, label, [
      "id", "os", "arch", "rid", "runtime", "deployment", "minOS", "universalSlices",
    ]);
    string(item.id, `${label}.id`);
    oneOf(item.os, hostOperatingSystems, `${label}.os`);
    oneOf(item.arch, hostArchitectures, `${label}.arch`);
    string(item.rid, `${label}.rid`);
    string(item.runtime, `${label}.runtime`);
    oneOf(item.deployment, ["self-contained", "framework-dependent"], `${label}.deployment`);
    string(item.minOS, `${label}.minOS`);
    const slices = uniqueStrings(item.universalSlices, `${label}.universalSlices`);
    if (item.arch === "universal") {
      if (!sameJson([...slices].sort(), ["arm64", "x64"])) {
        fail("universalSlices", `${label} must declare x64 and arm64 slices.`);
      }
    } else if (slices.length !== 0) fail("universalSlices", `${label} is not universal.`);
    if (ids.has(item.id)) fail("duplicateTarget", `Duplicate target ${item.id}.`);
    ids.add(item.id);
  }
  return { targets, ids };
}

export function validateBuild(value, label = "build") {
  const item = record(value, label, ["workflow", "toolchain", "target"]);
  string(item.workflow, `${label}.workflow`);
  const tools = list(item.toolchain, `${label}.toolchain`, { min: 1 });
  for (const [index, tool] of tools.entries()) {
    const entry = record(tool, `${label}.toolchain[${index}]`, ["name", "version"]);
    string(entry.name, `${label}.toolchain[${index}].name`);
    string(entry.version, `${label}.toolchain[${index}].version`);
  }
  string(item.target, `${label}.target`);
  return item;
}

export function validatePipeline(value) {
  const pipeline = list(value, "pipeline");
  if (!sameJson(pipeline, releasePipeline)) {
    fail("pipelineOrder", "Release pipeline must preserve the frozen acyclic order.");
  }
  return pipeline;
}

export function validateInventory(value, label) {
  const inventory = list(value, label, { min: 1 });
  const paths = new Set();
  const folded = new Set();
  for (const [index, value] of inventory.entries()) {
    const entry = record(value, `${label}[${index}]`, ["path", "byteLength", "digest"]);
    const path = safeArchivePath(string(entry.path, `${label}[${index}].path`));
    integer(entry.byteLength, `${label}[${index}].byteLength`);
    digest(entry.digest, `${label}[${index}].digest`);
    const lower = path.toLocaleLowerCase("en-US");
    if (paths.has(path)) fail("duplicateInventory", `${label} duplicates ${path}.`);
    if (folded.has(lower)) fail("inventoryCaseCollision", `${label} collides by case at ${path}.`);
    paths.add(path);
    folded.add(lower);
  }
  return inventory;
}

export function validateSignature(value, label, { allowPlanned }) {
  const base = record(value, label, ["status", "identity", "evidence"], ["status"]);
  const states = allowPlanned
    ? ["planned", "unsigned", "unverified", "verified"] : ["unsigned", "unverified", "verified"];
  oneOf(base.status, states, `${label}.status`);
  if (base.status === "unsigned" || base.status === "planned") {
    if (Object.hasOwn(base, "identity") || Object.hasOwn(base, "evidence")) {
      fail("signatureFact", `${label}.${base.status} cannot claim identity or evidence.`);
    }
    return base;
  }
  string(base.identity, `${label}.identity`);
  const evidence = record(base.evidence, `${label}.evidence`, [
    "kind", "path", "byteLength", "digest", "subjectDigest",
  ]);
  oneOf(evidence.kind, ["embedded-verification", "detached-signature", "notarization-ticket"],
    `${label}.evidence.kind`);
  safeArchivePath(string(evidence.path, `${label}.evidence.path`));
  integer(evidence.byteLength, `${label}.evidence.byteLength`, { min: 1 });
  digest(evidence.digest, `${label}.evidence.digest`);
  digest(evidence.subjectDigest, `${label}.evidence.subjectDigest`);
  return base;
}

export function validateAuxiliary(value, label) {
  const item = record(value, label, ["path", "byteLength", "digest"]);
  safeArchivePath(string(item.path, `${label}.path`));
  integer(item.byteLength, `${label}.byteLength`, { min: 1 });
  digest(item.digest, `${label}.digest`);
  return item;
}
