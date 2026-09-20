export function validDefinition(
  testId = "service-test:reference/smoke",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    testId,
    title: "Reference smoke",
    description: "Runs a registered reference task.",
    caseSpecs: [],
    coverage: {
      includes: ["startup"],
      exclusions: [{ target: "real-network", reason: "Contract task is offline." }],
    },
    parameters: {
      type: "object",
      properties: {
        locale: {
          type: "string",
          description: "Locale selected by the fixture.",
          default: "zh-CN",
          enum: ["zh-CN", "en-US"],
        },
        retries: {
          type: "integer",
          description: "Bounded retry count.",
          default: 0,
        },
      },
      required: ["locale"],
      additionalProperties: false,
    },
    runtime: { executorId: "registered.node", kind: "node" },
    effect: "readOnly",
    requirements: {
      platforms: ["darwin", "linux", "win32"],
      capabilities: ["node"],
      environment: [],
    },
    output: {
      resultFormat: "surfaceloom.run-result/v1",
      artifacts: [
        { name: "report.json", mediaType: "application/json", required: true },
      ],
    },
  };
}
