export const nativeProtocolName = "surfaceloom.native" as const;
export const nativeProtocolVersion = "1.0" as const;
export const supportedNativeProtocolVersions = Object.freeze([nativeProtocolVersion] as const);

/** One UTF-8 JSON object plus one LF. A transport must reject larger frames before JSON parsing. */
export const maxWireMessageBytes = 1_048_576;
export const maxDeadlineMs = 120_000;

/** Normative timing boundary shared by clients and hosts. */
export const wireDeadlinePolicy = Object.freeze({
  startsAt: "frameReceived" as const,
  covers: Object.freeze([
    "protocolValidation", "schemaValidation", "queue", "operation", "response",
  ] as const),
});

export const operationIntents = ["observe", "mutate", "lifecycle"] as const;
export const operationOutcomes = ["notExecuted", "executed", "unknown"] as const;
export const sessionOwnerships = ["owned", "borrowed"] as const;
export const errorCategories = [
  "protocol", "invalidRequest", "unsupported", "notFound", "permissionDenied",
  "deadline", "cancelled", "conflict", "backend", "internal",
] as const;
export const retryDispositions = ["never", "safe"] as const;
export const cancellationReasons = ["caller", "deadline", "shutdown"] as const;
