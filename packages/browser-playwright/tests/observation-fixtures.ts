import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserAutomationError,
  PlaywrightBrowserBackend,
  type BrowserObservation,
  type BrowserSession,
} from "../src/index.js";
import {
  fakePlaywright,
  type FakeBrowserType,
  type FakeContext,
  type FakePage,
} from "./fakes.js";

export const observedEvents = [
  "console",
  "pageerror",
  "request",
  "requestfinished",
  "requestfailed",
  "response",
] as const;

export async function openSession(): Promise<{
  readonly session: BrowserSession;
  readonly page: FakePage;
  readonly context: FakeContext;
}> {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const session = await new PlaywrightBrowserBackend(async () => module).launch();
  return {
    session,
    page: browserType.browser.context.page,
    context: browserType.browser.context,
  };
}

export function capture(
  error: unknown,
  messages: string[],
  code: BrowserAutomationError["code"],
): boolean {
  assert.ok(error instanceof BrowserAutomationError);
  messages.push(error.message);
  return error.code === code;
}

/** The pairing a caller is expected to run: settle by request identity. */
export function unsettled(
  observations: readonly BrowserObservation[],
): readonly BrowserObservation[] {
  const settled = new Set(
    observations
      .filter(
        (record) =>
          record.kind === "requestFinished" || record.kind === "requestFailed",
      )
      .map((record) => record.requestId),
  );
  return observations
    .filter((record) => record.kind === "requestStarted")
    .filter((record) => !settled.has(record.requestId));
}

export function shape(record: BrowserObservation): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy["at"];
  return copy;
}

export function consoleMessage(level: string, text: string): unknown {
  return { type: (): string => level, text: (): string => text };
}

export function requestPayload(method: string, url: string, failure?: string): unknown {
  return {
    method: (): string => method,
    url: (): string => url,
    failure: (): { errorText: string } | null =>
      failure === undefined ? null : { errorText: failure },
  };
}

export function responsePayload(
  status: number,
  url: string,
  method: string,
  origin: unknown = requestPayload(method, url),
): unknown {
  return {
    status: (): number => status,
    url: (): string => url,
    // A real Response hands back the very Request instance the request events carried.
    request: (): unknown => origin,
  };
}
