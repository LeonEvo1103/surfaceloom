export type TracePrimitive = string | number | boolean | null;
export interface TraceObject {
  readonly [key: string]: TraceValue;
}
export type TraceValue =
  | TracePrimitive
  | readonly TraceValue[]
  | TraceObject;

interface TraceContext {
  readonly sessionId?: string;
  readonly componentId?: string;
  readonly action?: string;
  readonly locatorKey?: string;
}

export type TraceEventInput =
  | (TraceContext & {
      readonly kind: "operation.started";
      readonly operationId: string;
      readonly details?: Readonly<Record<string, TraceValue>>;
    })
  | (TraceContext & {
      readonly kind: "operation.finished";
      readonly operationId: string;
      readonly outcome: "passed" | "failed" | "unsupported";
      readonly durationMs: number;
      readonly details?: Readonly<Record<string, TraceValue>>;
    })
  | (TraceContext & {
      readonly kind: "diagnostic";
      readonly level: "info" | "warning" | "error";
      readonly message: string;
      readonly sensitive?: boolean;
      readonly details?: Readonly<Record<string, TraceValue>>;
    })
  | (TraceContext & {
      readonly kind: "attachment";
      readonly name: string;
      readonly contentType: string;
      readonly path: string;
      readonly sensitive?: boolean;
    });

export type TraceEvent = TraceEventInput & {
  readonly sequence: number;
  readonly timestamp: string;
};

export interface TraceSink {
  record(event: TraceEventInput): void;
}

export interface TraceRecorderOptions {
  readonly now?: () => Date;
  readonly sensitiveKeyPattern?: RegExp;
}

export class InMemoryTraceRecorder implements TraceSink {
  readonly #events: TraceEvent[] = [];
  readonly #now: () => Date;
  readonly #sensitiveKeyPattern: RegExp;

  constructor(options: TraceRecorderOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#sensitiveKeyPattern =
      options.sensitiveKeyPattern ??
      /secret|token|password|authorization|cookie|api[-_]?key|credential|prompt|transcript|conversation|arguments|filePath/i;
  }

  record(event: TraceEventInput): void {
    const safeEvent = sanitizeEvent(event, this.#sensitiveKeyPattern);
    this.#events.push(
      Object.freeze({
        ...safeEvent,
        sequence: this.#events.length + 1,
        timestamp: this.#now().toISOString(),
      }) as TraceEvent,
    );
  }

  snapshot(): readonly TraceEvent[] {
    return Object.freeze([...this.#events]);
  }
}

function sanitizeEvent(
  event: TraceEventInput,
  sensitiveKeyPattern: RegExp,
): TraceEventInput {
  const details =
    "details" in event && event.details !== undefined
      ? sanitizeRecord(event.details, sensitiveKeyPattern)
      : undefined;
  if (event.kind === "diagnostic") {
    return Object.freeze({
      ...event,
      message: event.sensitive ? "[REDACTED]" : redactText(event.message),
      ...(details === undefined ? {} : { details }),
    });
  }
  if (event.kind === "attachment") {
    return Object.freeze({
      ...event,
      name: redactText(event.name),
      path: event.sensitive ? "[REDACTED]" : redactText(event.path),
    });
  }
  return Object.freeze({
    ...event,
    ...(details === undefined ? {} : { details }),
  });
}

function sanitizeRecord(
  value: Readonly<Record<string, TraceValue>>,
  sensitiveKeyPattern: RegExp,
  depth = 8,
  seen = new WeakSet<object>(),
): Readonly<Record<string, TraceValue>> {
  seen.add(value);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        matchesSensitiveKey(sensitiveKeyPattern, key)
          ? "[REDACTED]"
          : sanitizeValue(item, sensitiveKeyPattern, depth - 1, seen),
      ]),
    ),
  );
}

function matchesSensitiveKey(pattern: RegExp, key: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(key);
}

function sanitizeValue(
  value: TraceValue,
  pattern: RegExp,
  depth: number,
  seen: WeakSet<object>,
): TraceValue {
  if (typeof value === "string") return redactText(value);
  if (depth < 0) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result = Object.freeze(
      value.map((item) => sanitizeValue(item, pattern, depth - 1, seen)),
    );
    seen.delete(value);
    return result;
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    const result = sanitizeRecord(
      value as Readonly<Record<string, TraceValue>>,
      pattern,
      depth,
      seen,
    );
    seen.delete(value);
    return result;
  }
  return value;
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|token|password|secret|authorization|cookie))\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}
