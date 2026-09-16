import type { BrowserObservation, BrowserObservationKind } from "./contracts.js";

interface ObservationFields {
  readonly requestId?: number | undefined;
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  readonly status?: number | undefined;
  readonly level?: string | undefined;
  readonly text?: string | undefined;
  readonly failure?: string | undefined;
}

export type ObservationBinding = readonly [string, (payload: unknown) => void];

/**
 * Page events this session normalizes. The session only records; which level is a
 * violation, which status is an error, and what counts as a long pending request are
 * all product decisions left to the caller.
 */
export function observationBindings(
  sink: (observation: BrowserObservation) => void,
  identify: (payload: unknown) => number | undefined,
): readonly ObservationBinding[] {
  const request = (payload: unknown): ObservationFields => ({
    requestId: identify(payload),
    url: textOf(callMethod(payload, "url")),
    method: textOf(callMethod(payload, "method")),
  });
  return [
    binding("console", sink, "consoleMessage", (payload) => ({
      level: textOf(callMethod(payload, "type")),
      text: textOf(callMethod(payload, "text")),
    })),
    binding("pageerror", sink, "pageError", (payload) => ({
      text: pageErrorText(payload),
    })),
    binding("request", sink, "requestStarted", request),
    binding("requestfinished", sink, "requestFinished", request),
    binding("requestfailed", sink, "requestFailed", (payload) => ({
      ...request(payload),
      failure: textOf(readProperty(callMethod(payload, "failure"), "errorText")),
    })),
    binding("response", sink, "response", (payload) => {
      // response.request() is the very instance the request events carried.
      const origin = callMethod(payload, "request");
      return {
        requestId: identify(origin),
        url: textOf(callMethod(payload, "url")),
        method: textOf(callMethod(origin, "method")),
        status: numberOf(callMethod(payload, "status")),
      };
    }),
  ];
}

function binding(
  event: string,
  sink: (observation: BrowserObservation) => void,
  kind: BrowserObservationKind,
  read: (payload: unknown) => ObservationFields,
): ObservationBinding {
  return [
    event,
    (payload: unknown): void => {
      try {
        sink(observation(kind, read(payload)));
      } catch {
        // Playwright dispatches page events synchronously inside the action being
        // driven, so a throwing listener would fail the action under test. A lost
        // signal is recorded rather than dropped, because a silently empty stream
        // would read as "the page was clean". The marker carries no payload data.
        sink(observation("pageError", { text: observationFailureText }));
      }
    },
  ];
}

const observationFailureText = "A browser page event could not be normalized.";

function observation(
  kind: BrowserObservationKind,
  fields: ObservationFields,
): BrowserObservation {
  return Object.freeze({
    kind,
    at: new Date().toISOString(),
    ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
    ...(fields.url === undefined ? {} : { url: fields.url }),
    ...(fields.method === undefined ? {} : { method: fields.method }),
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.level === undefined ? {} : { level: fields.level }),
    ...(fields.text === undefined ? {} : { text: fields.text }),
    ...(fields.failure === undefined ? {} : { failure: fields.failure }),
    sensitive: true as const,
  });
}

function pageErrorText(payload: unknown): string | undefined {
  if (payload instanceof Error) return textOf(payload.message);
  return textOf(readProperty(payload, "message")) ?? textOf(payload);
}

function callMethod(source: unknown, name: string): unknown {
  const method = readProperty(source, name);
  if (typeof method !== "function") return undefined;
  return (method as (this: unknown) => unknown).call(source);
}

function readProperty(source: unknown, name: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as Record<string, unknown>)[name];
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
