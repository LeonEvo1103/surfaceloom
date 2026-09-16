import type { CaseSpec, TestPlatform } from "@surfaceloom/core";

import type { CaseExecutionResultInput } from "../model.js";
import { redactReportText } from "../redact.js";
import { sanitizeRunInput, sanitizeTestCase } from "../sanitize.js";
import type {
  CaseReportV3Input,
  ContextValue,
  ReportBundleV3Input,
  ReportHostV3,
  ReportRunV3,
  ReportSurfaceV3,
  UnknownContext,
} from "./model.js";
import { validateReportV3Input } from "./validate.js";
import { snapshotReportV3Input } from "./runtime-shape.js";

export function sanitizeReportV3Input(input: ReportBundleV3Input): ReportBundleV3Input {
  const snapshot = snapshotReportV3Input(input);
  validateReportV3Input(snapshot);
  const tests = Object.freeze(snapshot.tests.map((test) => Object.freeze(sanitizeCase(test))));
  return Object.freeze({ run: sanitizeRun(snapshot.run, snapshot.tests[0]!.spec.platforms[0]!), tests });
}

function sanitizeRun(run: ReportRunV3, platform: TestPlatform): ReportRunV3 {
  const safe = sanitizeRunInput({
    id: run.id,
    title: run.title,
    platform,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    app: run.app,
    ...(run.environment === undefined ? {} : { environment: run.environment }),
  });
  return Object.freeze({
    id: safe.id,
    title: safe.title,
    startedAt: safe.startedAt,
    finishedAt: safe.finishedAt,
    app: safe.app,
    ...(safe.environment === undefined ? {} : { environment: safe.environment }),
    provenance: sanitizeProvenance(run.provenance),
    hosts: sanitizeHosts(run.hosts),
    surfaces: sanitizeSurfaces(run.surfaces),
  });
}

function sanitizeProvenance(run: ReportRunV3["provenance"]): ReportRunV3["provenance"] {
  if (run.kind === "native") return Object.freeze({ kind: "native" });
  return Object.freeze({
    kind: "imported-v2",
    sourceSchemaVersion: run.sourceSchemaVersion,
    sourcePlatform: run.sourcePlatform,
    limitations: Object.freeze([...run.limitations]),
  });
}

function sanitizeHosts(
  context: ContextValue<readonly ReportHostV3[]>,
): ContextValue<readonly ReportHostV3[]> {
  if (context.state === "unknown") return sanitizeUnknown(context);
  return Object.freeze({
    state: "known",
    value: Object.freeze([...context.value].sort(byId).map((host) => Object.freeze({
      id: host.id,
      os: host.os,
      ...(host.name === undefined ? {} : { name: redactReportText(host.name) }),
      ...(host.osVersion === undefined ? {} : { osVersion: redactReportText(host.osVersion) }),
      ...(host.architecture === undefined ? {} : {
        architecture: redactReportText(host.architecture),
      }),
    }))),
  });
}

function sanitizeSurfaces(
  context: ContextValue<readonly ReportSurfaceV3[]>,
): ContextValue<readonly ReportSurfaceV3[]> {
  if (context.state === "unknown") return sanitizeUnknown(context);
  return Object.freeze({
    state: "known",
    value: Object.freeze([...context.value].sort(byId).map((surface) => Object.freeze({
      id: surface.id,
      kind: surface.kind,
      hostId: sanitizeStringContext(surface.hostId),
      ...(surface.name === undefined ? {} : { name: redactReportText(surface.name) }),
      ...(surface.capabilities === undefined ? {} : {
        capabilities: Object.freeze([...surface.capabilities].sort(compareText)),
      }),
    }))),
  });
}

function sanitizeCase(test: CaseReportV3Input): CaseReportV3Input {
  if (test.attempts.state === "unknown") {
    const sanitized = sanitizeResult(test.spec, test.attempts.result);
    return {
      spec: sanitized.spec,
      attempts: Object.freeze({
        ...sanitizeUnknown(test.attempts),
        result: sanitized.result,
      }),
    };
  }
  const items = [...test.attempts.items]
    .sort((left, right) => left.ordinal - right.ordinal || compareText(left.id, right.id))
    .map((attempt) => {
      const sanitized = sanitizeResult(test.spec, attempt.result);
      return Object.freeze({
        id: attempt.id,
        ordinal: attempt.ordinal,
        executionPlatforms: Object.freeze([...attempt.executionPlatforms]
          .sort((left, right) => platformOrder(left) - platformOrder(right))),
        runnerHostId: sanitizeStringContext(attempt.runnerHostId),
        surfaceIds: attempt.surfaceIds.state === "unknown"
          ? sanitizeUnknown(attempt.surfaceIds)
          : Object.freeze({
              state: "known" as const,
              value: Object.freeze([...attempt.surfaceIds.value].sort(compareText)),
            }),
        result: sanitized.result,
      });
    });
  const first = sanitizeResult(test.spec, test.attempts.items[0]!.result);
  return {
    spec: first.spec,
    attempts: Object.freeze({
      state: "known",
      finalAttemptId: test.attempts.finalAttemptId,
      items: Object.freeze(items),
    }),
  };
}

function sanitizeResult(
  spec: CaseSpec,
  result: CaseExecutionResultInput,
): { readonly spec: CaseSpec; readonly result: CaseExecutionResultInput } {
  return sanitizeTestCase({ spec, result }) as {
    readonly spec: CaseSpec;
    readonly result: CaseExecutionResultInput;
  };
}

function sanitizeStringContext(context: ContextValue<string>): ContextValue<string> {
  return context.state === "unknown"
    ? sanitizeUnknown(context)
    : Object.freeze({ state: "known", value: context.value });
}

function sanitizeUnknown(context: UnknownContext): UnknownContext {
  return Object.freeze({
    state: "unknown",
    reason: context.reason,
    ...(context.detail === undefined ? {} : { detail: redactReportText(context.detail) }),
  });
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function platformOrder(value: TestPlatform): number {
  return ["macos", "windows", "web"].indexOf(value);
}
