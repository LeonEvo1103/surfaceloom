import {
  defineComponentManifest,
  type ActionabilityCheck,
  type ComponentActionManifest,
  type ComponentKind,
  type DesktopCapability,
  type DesktopPlatform,
  type SideEffectLevel,
} from "@surfaceloom/core";

import type { CatalogFixtureId } from "./fixtures.js";

const allDesktopPlatforms = ["macos", "windows"] as const;

interface ComponentSpec<Id extends string> {
  readonly id: Id;
  readonly name: string;
  readonly summary: string;
  readonly kind: ComponentKind;
  readonly sideEffectLevel: SideEffectLevel;
  readonly actions: readonly ComponentActionManifest[];
  readonly assertions: readonly string[];
  readonly locatorKeys: readonly string[];
  readonly platforms?: readonly DesktopPlatform[];
  readonly requiredCapabilities?: readonly DesktopCapability[];
  readonly tags?: readonly string[];
  readonly requiredFixtures?: readonly CatalogFixtureId[];
}

export function action(
  name: string,
  summary: string,
  sideEffectLevel?: SideEffectLevel,
  requiredCapabilities?: readonly DesktopCapability[],
  additionalActionabilityChecks?: readonly ActionabilityCheck[],
): ComponentActionManifest {
  return {
    name,
    summary,
    ...(sideEffectLevel === undefined ? {} : { sideEffectLevel }),
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
    ...(additionalActionabilityChecks === undefined
      ? {}
      : { additionalActionabilityChecks }),
  };
}

export function component<const Id extends string>(spec: ComponentSpec<Id>) {
  return defineComponentManifest({
    id: spec.id,
    version: "1.0.0",
    name: spec.name,
    summary: spec.summary,
    kind: spec.kind,
    platforms: spec.platforms ?? allDesktopPlatforms,
    requiredCapabilities: spec.requiredCapabilities ?? ["ui.inspect"],
    sideEffectLevel: spec.sideEffectLevel,
    actions: spec.actions,
    assertions: spec.assertions,
    locatorKeys: spec.locatorKeys,
    ...(spec.requiredFixtures === undefined
      ? {}
      : { requiredFixtures: spec.requiredFixtures }),
    ...(spec.tags === undefined ? {} : { tags: spec.tags }),
  });
}
