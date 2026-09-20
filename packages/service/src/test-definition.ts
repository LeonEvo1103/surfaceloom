import type { TestId } from "./ids.js";

const effectLevelValues = [
  "readOnly",
  "reversible",
  "writesLocal",
  "externalEffect",
  "securitySensitive",
] as const;

export type EffectLevel = (typeof effectLevelValues)[number];
export const effectLevels: readonly EffectLevel[] = Object.freeze([...effectLevelValues]);
export type RuntimeKind = "node" | "cli" | "surfaceloom-v3";
export type ServicePlatform = "darwin" | "linux" | "win32";
export type ParameterType = "string" | "number" | "integer" | "boolean";
export type ParameterValue = string | number | boolean;

export interface CaseSpecReference {
  /** Stable CaseSpec.id, not a service testId. */
  readonly id: string;
  /** Optional repository-relative sidecar or source label for discovery. */
  readonly source?: string;
}

export interface CoverageExclusion {
  readonly target: string;
  readonly reason: string;
}

export interface CoverageDeclaration {
  readonly includes: readonly string[];
  readonly exclusions: readonly CoverageExclusion[];
}

export interface ParameterDefinition {
  readonly type: ParameterType;
  readonly description: string;
  readonly default?: ParameterValue;
  readonly enum?: readonly ParameterValue[];
}

export interface ParameterSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, ParameterDefinition>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface RuntimeDeclaration {
  /** Selects a separately registered executor; it is never shell input. */
  readonly executorId: string;
  readonly kind: RuntimeKind;
}

export interface TestRequirements {
  readonly platforms: readonly ServicePlatform[];
  readonly capabilities: readonly string[];
  /** Names only; values and credentials never belong in the catalog. */
  readonly environment: readonly string[];
}

export interface ArtifactOutputDeclaration {
  readonly name: string;
  readonly mediaType: string;
  readonly required: boolean;
}

export interface OutputDeclaration {
  readonly resultFormat: "surfaceloom.run-result/v1";
  readonly artifacts: readonly ArtifactOutputDeclaration[];
}

export interface TestDefinition {
  readonly schemaVersion: 1;
  readonly testId: TestId;
  readonly title: string;
  readonly description: string;
  /** Explicitly present and allowed to contain zero or more CaseSpec references. */
  readonly caseSpecs: readonly CaseSpecReference[];
  readonly coverage: CoverageDeclaration;
  readonly parameters: ParameterSchema;
  readonly runtime: RuntimeDeclaration;
  readonly effect: EffectLevel;
  readonly requirements: TestRequirements;
  readonly output: OutputDeclaration;
}
