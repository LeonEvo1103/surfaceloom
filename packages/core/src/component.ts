import {
  desktopCapabilities,
  type DesktopCapability,
} from "./capabilities.js";
import {
  actionabilityChecks,
  type ActionabilityCheck,
} from "./actionability.js";
import {
  desktopPlatforms,
  type DesktopPlatform,
} from "./platform.js";

export const sideEffectLevels = [
  "readOnly",
  "reversible",
  "writesLocal",
  "externalEffect",
  "securitySensitive",
] as const;

export type SideEffectLevel = (typeof sideEffectLevels)[number];
export type ComponentKind = "common" | "system" | "agent";

export interface ComponentActionManifest {
  readonly name: string;
  readonly summary: string;
  readonly sideEffectLevel?: SideEffectLevel;
  readonly requiredCapabilities?: readonly DesktopCapability[];
  readonly additionalActionabilityChecks?: readonly ActionabilityCheck[];
}

export interface ComponentManifest {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly summary: string;
  readonly kind: ComponentKind;
  readonly platforms: readonly DesktopPlatform[];
  readonly requiredCapabilities: readonly DesktopCapability[];
  /** Maximum expected effect unless an action explicitly declares another level. */
  readonly sideEffectLevel: SideEffectLevel;
  readonly actions: readonly ComponentActionManifest[];
  readonly assertions: readonly string[];
  readonly locatorKeys: readonly string[];
  /** Named, deterministic resources which the runner creates only on demand. */
  readonly requiredFixtures?: readonly string[];
  readonly tags?: readonly string[];
}

const sideEffectRank = new Map(
  sideEffectLevels.map((level, index) => [level, index] as const),
);

export function compareSideEffectLevel(
  left: SideEffectLevel,
  right: SideEffectLevel,
): number {
  return getSideEffectRank(left) - getSideEffectRank(right);
}

export function isSideEffectAtMost(
  level: SideEffectLevel,
  maximum: SideEffectLevel,
): boolean {
  return compareSideEffectLevel(level, maximum) <= 0;
}

export function defineComponentManifest<const T extends ComponentManifest>(
  manifest: T,
): Readonly<T> {
  assertNonEmpty("component id", manifest.id);
  assertNonEmpty("component name", manifest.name);
  assertNonEmpty("component version", manifest.version);
  assertUnique("platform", manifest.platforms);
  assertUnique("capability", manifest.requiredCapabilities);
  assertUnique("action", manifest.actions.map((action) => action.name));
  assertUnique("assertion", manifest.assertions);
  assertUnique("locator key", manifest.locatorKeys);
  assertUnique("fixture", manifest.requiredFixtures ?? []);
  for (const fixture of manifest.requiredFixtures ?? []) {
    assertNonEmpty("fixture", fixture);
  }

  for (const platform of manifest.platforms) {
    if (!desktopPlatforms.includes(platform)) {
      throw new Error(`Unknown desktop platform: ${platform}`);
    }
  }
  for (const capability of manifest.requiredCapabilities) {
    if (!desktopCapabilities.includes(capability)) {
      throw new Error(`Unknown desktop capability: ${capability}`);
    }
  }
  for (const action of manifest.actions) {
    assertNonEmpty("action name", action.name);
    assertNonEmpty("action summary", action.summary);
    if (
      action.sideEffectLevel !== undefined &&
      !isSideEffectAtMost(action.sideEffectLevel, manifest.sideEffectLevel)
    ) {
      throw new Error(
        `Action ${action.name} exceeds component side-effect level ${manifest.sideEffectLevel}.`,
      );
    }
    for (const capability of action.requiredCapabilities ?? []) {
      if (!desktopCapabilities.includes(capability)) {
        throw new Error(`Unknown desktop capability: ${capability}`);
      }
    }
    assertUnique(
      "actionability check",
      action.additionalActionabilityChecks ?? [],
    );
    for (const check of action.additionalActionabilityChecks ?? []) {
      if (!actionabilityChecks.includes(check)) {
        throw new Error(`Unknown actionability check: ${check}`);
      }
    }
  }

  return Object.freeze({
    ...manifest,
    platforms: Object.freeze([...manifest.platforms]),
    requiredCapabilities: Object.freeze([...manifest.requiredCapabilities]),
    actions: Object.freeze(
      manifest.actions.map((action) =>
        Object.freeze({
          ...action,
          ...(action.requiredCapabilities === undefined
            ? {}
            : {
                requiredCapabilities: Object.freeze([
                  ...action.requiredCapabilities,
                ]),
              }),
          ...(action.additionalActionabilityChecks === undefined
            ? {}
            : {
                additionalActionabilityChecks: Object.freeze([
                  ...action.additionalActionabilityChecks,
                ]),
              }),
        }),
      ),
    ),
    assertions: Object.freeze([...manifest.assertions]),
    locatorKeys: Object.freeze([...manifest.locatorKeys]),
    ...(manifest.requiredFixtures === undefined
      ? {}
      : { requiredFixtures: Object.freeze([...manifest.requiredFixtures]) }),
    ...(manifest.tags === undefined
      ? {}
      : { tags: Object.freeze([...manifest.tags]) }),
  }) as Readonly<T>;
}

function getSideEffectRank(level: SideEffectLevel): number {
  const rank = sideEffectRank.get(level);
  if (rank === undefined) {
    throw new Error(`Unknown side-effect level: ${level}`);
  }
  return rank;
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`A ${label} must not be empty.`);
  }
}

function assertUnique(label: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}
