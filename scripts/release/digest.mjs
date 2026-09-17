import { createHash } from "node:crypto";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestRecord(bytes) {
  const value = Buffer.from(bytes);
  return Object.freeze({ algorithm: "sha256", value: sha256(value) });
}

export function canonicalInventoryDigest(inventory) {
  const canonical = inventory.map((entry) =>
    `${entry.path}\t${entry.byteLength}\t${entry.digest.algorithm}:${entry.digest.value}`
  ).join("\n");
  return sha256(Buffer.from(canonical, "utf8"));
}

export function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
    && value !== "0".repeat(64);
}

export function sameDigest(left, right) {
  return left !== null && right !== null && typeof left === "object" && typeof right === "object"
    && left.algorithm === "sha256" && right.algorithm === "sha256" && left.value === right.value;
}
