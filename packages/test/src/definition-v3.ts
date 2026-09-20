import type { CaseContext, CaseDefinition } from "./contracts.js";
import { defineCase } from "./definition.js";
import { snapshotJudgeCriteriaV3 } from "./judge/criteria.js";
import type { JudgeCriterionV3 } from "./judge/contracts.js";
import type {
  CaseContextV3,
  CaseDefinitionV3,
  CaseDefinitionV3Input,
} from "./runner-v3-contracts.js";
import { types } from "node:util";

const definitions = new WeakSet<object>();
const criteriaByDefinition = new WeakMap<object, readonly JudgeCriterionV3[]>();

export function defineCaseV3(input: CaseDefinitionV3Input): CaseDefinitionV3 {
  if (typeof input !== "object" || input === null || types.isProxy(input)) {
    throw new Error("Case v3 definition must be a non-Proxy object.");
  }
  const criterionDescriptor = Object.getOwnPropertyDescriptor(input, "judgeCriteria");
  if (criterionDescriptor !== undefined && (!("value" in criterionDescriptor)
      || !criterionDescriptor.enumerable)) {
    throw new Error("Case v3 judgeCriteria must be an enumerable data field.");
  }
  if (typeof input.run !== "function") throw new Error("Case v3 requires a run function.");
  // Keep defineCase's original-to-snapshot fixture resolver. The v3 runner supplies
  // the extended context before calling this wrapper; a second fixture snapshot is forbidden.
  const normalized = defineCase({ spec: input.spec,
    ...(input.fixtures === undefined ? {} : { fixtures: input.fixtures }),
    run: (context: CaseContext) => input.run(context as CaseContextV3),
  });
  const definition = normalized as CaseDefinition & CaseDefinitionV3;
  const criteria = snapshotJudgeCriteriaV3(criterionDescriptor?.value,
    normalized.spec.acceptanceCriteria.map((item) => item.id));
  definitions.add(definition);
  criteriaByDefinition.set(definition, criteria);
  return definition;
}

export function requireCaseV3(input: CaseDefinitionV3): void {
  if (!definitions.has(input)) throw new Error("Case v3 must come from defineCaseV3().");
}

export function judgeCriteriaForCaseV3(input: CaseDefinitionV3): readonly JudgeCriterionV3[] {
  requireCaseV3(input);
  return criteriaByDefinition.get(input) ?? Object.freeze([]);
}
