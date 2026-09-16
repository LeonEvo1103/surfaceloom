import {
  isSideEffectAtMost,
  type ComponentKind,
  type ComponentManifest,
  type DesktopCapability,
  type DesktopPlatform,
  type SideEffectLevel,
} from "@surfaceloom/core";

import { agentComponents } from "./agent.js";
import { commonComponents } from "./common.js";
import { systemComponents } from "./system.js";
import type { CatalogFixtureId } from "./fixtures.js";

export const componentCatalog = [
  ...commonComponents,
  ...systemComponents,
  ...agentComponents,
] as const satisfies readonly ComponentManifest[];

export type ComponentId = (typeof componentCatalog)[number]["id"];

export interface CatalogQuery {
  readonly kind?: ComponentKind;
  readonly platform?: DesktopPlatform;
  readonly capability?: DesktopCapability;
  readonly maximumSideEffectLevel?: SideEffectLevel;
  readonly tag?: string;
  readonly fixture?: CatalogFixtureId;
}

export function listComponentManifests(
  query: CatalogQuery = {},
): readonly ComponentManifest[] {
  return componentCatalog.filter((manifest) => {
    if (query.kind !== undefined && manifest.kind !== query.kind) {
      return false;
    }
    if (query.platform !== undefined && !manifest.platforms.includes(query.platform)) {
      return false;
    }
    if (
      query.capability !== undefined &&
      !manifest.requiredCapabilities.includes(query.capability)
    ) {
      return false;
    }
    if (
      query.maximumSideEffectLevel !== undefined &&
      !isSideEffectAtMost(manifest.sideEffectLevel, query.maximumSideEffectLevel)
    ) {
      return false;
    }
    if (query.tag !== undefined && !manifest.tags?.includes(query.tag)) {
      return false;
    }
    if (
      query.fixture !== undefined &&
      !(manifest.requiredFixtures as readonly string[] | undefined)?.includes(
        query.fixture,
      )
    ) {
      return false;
    }
    return true;
  });
}

export function getComponentManifest(id: string): ComponentManifest | undefined {
  return componentCatalog.find((manifest) => manifest.id === id);
}

export function requireComponentManifest(id: string): ComponentManifest {
  const manifest = getComponentManifest(id);
  if (manifest === undefined) {
    throw new Error(`Unknown desktop component: ${id}`);
  }
  return manifest;
}
