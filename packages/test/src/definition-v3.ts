import type { CaseContext, CaseDefinition } from "./contracts.js";
import { defineCase } from "./definition.js";
import type { CaseContextV3, CaseDefinitionV3 } from "./runner-v3-contracts.js";

const definitions = new WeakSet<object>();

export function defineCaseV3(input: CaseDefinitionV3): CaseDefinitionV3 {
  if (typeof input.run !== "function") throw new Error("Case v3 requires a run function.");
  // Keep defineCase's original-to-snapshot fixture resolver. The v3 runner supplies
  // the extended context before calling this wrapper; a second fixture snapshot is forbidden.
  const normalized = defineCase({ spec: input.spec,
    ...(input.fixtures === undefined ? {} : { fixtures: input.fixtures }),
    run: (context: CaseContext) => input.run(context as CaseContextV3),
  });
  const definition = normalized as CaseDefinition & CaseDefinitionV3;
  definitions.add(definition);
  return definition;
}

export function requireCaseV3(input: CaseDefinitionV3): void {
  if (!definitions.has(input)) throw new Error("Case v3 must come from defineCaseV3().");
}
