import { sideEffectLevels, type SideEffectLevel } from "./component.js";
import { testPlatforms, type TestPlatform } from "./platform.js";

/**
 * Execution-independent meaning of one test case.
 *
 * A runner records status, timing, steps and evidence separately. Keeping those
 * fields out of CaseSpec prevents a failed run from rewriting what the case is
 * supposed to prove.
 */
export interface CaseSpec {
  /** Stable machine-readable identity. Never put paths, credentials or user data here. */
  readonly id: string;
  /** BCP 47-ish language tag for all canonical human-readable fields. */
  readonly locale: string;
  /** Platforms on which this case has an executable, platform-mapped implementation. */
  readonly platforms: readonly TestPlatform[];
  /** Stable and human-readable functional area. */
  readonly suite: CaseSuite;
  /** Canonical human-readable case name. */
  readonly name: string;
  /** Optional upstream runner name, retained only for source-result reconciliation. */
  readonly sourceName?: string;
  /** Original product/requirement meaning: why this case exists and what risk it protects. */
  readonly intent: string;
  /** State that must already be true before the runner begins the case. */
  readonly preconditions: readonly CaseClause[];
  /** Observable outcomes required for this case to pass. */
  readonly acceptanceCriteria: readonly CaseClause[];
  /** Maximum side effect the complete case is allowed to produce. */
  readonly sideEffect: SideEffectLevel;
  readonly tags?: readonly string[];
}

export interface CaseSuite {
  readonly id: string;
  readonly name: string;
}

export interface CaseClause {
  readonly id: string;
  readonly text: string;
}

/**
 * Defines and freezes a case contract before any platform runner executes it.
 */
export function defineCaseSpec(spec: CaseSpec): Readonly<CaseSpec> {
  exactKeys("case spec", spec, [
    "id", "locale", "platforms", "suite", "name", "sourceName", "intent", "preconditions",
    "acceptanceCriteria", "sideEffect", "tags",
  ]);
  exactKeys("case suite", spec.suite, ["id", "name"]);
  stableIdentifier("case id", spec.id);
  locale("case locale", spec.locale);
  validatePlatforms(spec.platforms);
  stableIdentifier("suite id", spec.suite.id);
  nonEmpty("suite name", spec.suite.name);
  nonEmpty("case name", spec.name);
  if (spec.sourceName !== undefined) nonEmpty("case source name", spec.sourceName);
  nonEmpty("case intent", spec.intent);
  if (!sideEffectLevels.includes(spec.sideEffect)) {
    throw new Error(`Unknown side-effect level: ${String(spec.sideEffect)}`);
  }
  if (!Array.isArray(spec.preconditions)) {
    throw new Error("Case preconditions must be an array.");
  }
  if (!Array.isArray(spec.acceptanceCriteria)) {
    throw new Error("Case acceptance criteria must be an array.");
  }
  if (spec.tags !== undefined && !Array.isArray(spec.tags)) {
    throw new Error("Case tags must be an array.");
  }
  if (spec.acceptanceCriteria.length === 0) {
    throw new Error("A case must include at least one acceptance criterion.");
  }
  validateClauses("precondition", spec.preconditions);
  validateClauses("acceptance criterion", spec.acceptanceCriteria);
  validateTextList("tag", spec.tags ?? []);
  validateCanonicalLanguage(spec);

  return Object.freeze({
    id: spec.id,
    locale: spec.locale,
    platforms: Object.freeze([...spec.platforms]),
    suite: Object.freeze({ ...spec.suite }),
    name: spec.name,
    ...(spec.sourceName === undefined ? {} : { sourceName: spec.sourceName }),
    intent: spec.intent,
    preconditions: Object.freeze(spec.preconditions.map((item) =>
      Object.freeze({ ...item }),
    )),
    acceptanceCriteria: Object.freeze(spec.acceptanceCriteria.map((item) =>
      Object.freeze({ ...item }),
    )),
    sideEffect: spec.sideEffect,
    ...(spec.tags === undefined
      ? {}
      : { tags: Object.freeze([...spec.tags]) }),
  });
}

function validatePlatforms(values: readonly TestPlatform[]): void {
  if (!Array.isArray(values)) {
    throw new Error("Case platforms must be an array.");
  }
  if (values.length === 0) {
    throw new Error("A case must include at least one platform.");
  }
  const seen = new Set<TestPlatform>();
  for (const value of values) {
    if (!testPlatforms.includes(value)) {
      throw new Error(`Unknown test platform: ${String(value)}`);
    }
    if (seen.has(value)) {
      throw new Error(`Duplicate case platform: ${value}`);
    }
    seen.add(value);
  }
}

function locale(label: string, value: string): void {
  nonEmpty(label, value);
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value)) {
    throw new Error(`A ${label} must be a language tag such as zh-CN or en-US.`);
  }
}

function validateClauses(label: string, values: readonly CaseClause[]): void {
  const identifiers = new Set<string>();
  for (const value of values) {
    exactKeys(label, value, ["id", "text"]);
    stableIdentifier(`${label} id`, value.id);
    nonEmpty(label, value.text);
    if (identifiers.has(value.id)) throw new Error(`Duplicate ${label} id: ${value.id}`);
    identifiers.add(value.id);
  }
}

function exactKeys(label: string, value: unknown, allowed: readonly string[]): void {
  const record = plainRecord(label, value);
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`A ${label} contains an unknown field: ${unknown[0]}.`);
  }
}

function plainRecord(label: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`A ${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`A ${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function validateCanonicalLanguage(spec: CaseSpec): void {
  if (!spec.locale.toLowerCase().startsWith("zh")) return;
  const texts = [
    ["suite name", spec.suite.name],
    ["case name", spec.name],
    ["case intent", spec.intent],
    ...spec.preconditions.map((item) => ["precondition", item.text]),
    ...spec.acceptanceCriteria.map((item) => ["acceptance criterion", item.text]),
  ] as const;
  for (const [label, value] of texts) {
    if (!/\p{Script=Han}/u.test(value)) {
      throw new Error(`A zh case ${label} must contain Chinese text.`);
    }
  }
}

function stableIdentifier(label: string, value: string): void {
  nonEmpty(label, value);
  if (value.length > 200) {
    throw new Error(`A ${label} must not exceed 200 characters.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)) {
    throw new Error(`A ${label} must use the stable machine-id character set.`);
  }
}

function validateTextList(label: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(label, value);
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function nonEmpty(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`A ${label} must be a string.`);
  }
  if (value.trim().length === 0) {
    throw new Error(`A ${label} must not be empty.`);
  }
}
