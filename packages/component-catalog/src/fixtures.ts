import type { FixtureScope } from "@surfaceloom/core";

export interface FixtureManifest {
  readonly id: string;
  readonly summary: string;
  readonly scope: FixtureScope;
}

export const fixtureCatalog = [
  {
    id: "desktop.filesystem-sandbox",
    summary: "A temporary file tree owned and removed by the test.",
    scope: "test",
  },
  {
    id: "agent.scripted-run",
    summary: "A deterministic model/run event script with no live model dependency.",
    scope: "test",
  },
  {
    id: "agent.tool-fixture",
    summary: "A fake tool service shared by a worker and namespaced per test.",
    scope: "worker",
  },
  {
    id: "agent.side-effect-probe",
    summary: "A per-test call ledger used to assert at-most-once side effects.",
    scope: "test",
  },
  {
    id: "agent.input-event-probe",
    summary: "A simulated input event source and stop-observation ledger.",
    scope: "test",
  },
  {
    id: "agent.recovery-state",
    summary: "A versioned interrupted-session checkpoint in an isolated profile.",
    scope: "test",
  },
  {
    id: "agent.command-fixture",
    summary: "A sandbox command executor with deterministic output and cancellation.",
    scope: "test",
  },
] as const satisfies readonly FixtureManifest[];

export type CatalogFixtureId = (typeof fixtureCatalog)[number]["id"];

export function isCatalogFixtureId(value: string): value is CatalogFixtureId {
  return fixtureCatalog.some((fixture) => fixture.id === value);
}
