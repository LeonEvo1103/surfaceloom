import { strictSemverPattern } from "./constants.mjs";

export function satisfiesDependencyRange(version, range) {
  const actual = parse(version);
  if (actual === undefined || typeof range !== "string") return false;
  if (strictSemverPattern.test(range)) return version === range;
  const operator = range[0];
  if (operator !== "^" && operator !== "~") return false;
  const base = parse(range.slice(1));
  if (base === undefined || actual.prerelease !== undefined || base.prerelease !== undefined
      || compare(actual, base) < 0) return false;
  if (operator === "~") return actual.major === base.major && actual.minor === base.minor;
  if (base.major > 0) return actual.major === base.major;
  if (base.minor > 0) return actual.major === 0 && actual.minor === base.minor;
  return actual.major === 0 && actual.minor === 0 && actual.patch === base.patch;
}

function parse(value) {
  if (!strictSemverPattern.test(value)) return undefined;
  const separator = value.indexOf("-");
  const core = separator < 0 ? value : value.slice(0, separator);
  const prerelease = separator < 0 ? undefined : value.slice(separator + 1);
  const [major, minor, patch] = core.split(".").map(Number);
  return { major, minor, patch, prerelease: prerelease?.split(".") };
}

function compare(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.prerelease === undefined) return right.prerelease === undefined ? 0 : 1;
  if (right.prerelease === undefined) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numericA = /^\d+$/u.test(a);
    const numericB = /^\d+$/u.test(b);
    if (numericA && numericB) return Number(a) < Number(b) ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}
