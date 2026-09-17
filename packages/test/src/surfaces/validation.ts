import { SurfaceProviderError } from "./errors.js";

export function stableId(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240
      || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)) {
    throw new SurfaceProviderError("invalidRequest", `${label} must be a stable identifier.`);
  }
  return value;
}

export function capabilities(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 1_000) {
    throw new SurfaceProviderError("invalidRequest", "Surface capabilities must be a bounded array.");
  }
  const normalized = values.map((value) => stableId("capability", value)).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new SurfaceProviderError("invalidRequest", "Surface capabilities must be unique.");
  }
  return Object.freeze(normalized);
}

export function effectiveCapabilities(
  declared: readonly string[],
  actual: readonly string[],
): readonly string[] {
  const requested = capabilities(declared);
  const available = new Set(capabilities(actual));
  const effective = requested.filter((item) => available.has(item));
  if (effective.length !== requested.length) {
    throw new SurfaceProviderError("capabilityMismatch",
      "The injected surface backend lacks a declared capability.");
  }
  return Object.freeze(effective);
}

export function timeout(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new SurfaceProviderError("invalidRequest", "Surface timeout is invalid.");
  }
  return Math.floor(value);
}
