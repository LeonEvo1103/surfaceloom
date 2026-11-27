import type { BrowserSurfaceSessionPort } from "./contracts.js";

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const maxReasonLength = 300;

/** Why a surface was asked to capture: a detected failure, or an `always` evidence policy. */
export type SurfaceCaptureTrigger = "failure" | "final";

export type SurfaceCaptureDecision =
  | { readonly requested: false }
  | { readonly requested: true; readonly trigger: SurfaceCaptureTrigger };

export type SurfaceCaptureOutcome =
  | { readonly surfaceId: string; readonly status: "captured"; readonly trigger: SurfaceCaptureTrigger;
    readonly mediaType: "image/png"; readonly bytes: Uint8Array; readonly capturedAt: string;
    readonly durationMs: number }
  | { readonly surfaceId: string; readonly status: "captureFailed" | "unsupported";
    readonly trigger: SurfaceCaptureTrigger; readonly reason: string; readonly capturedAt: string;
    readonly durationMs: number }
  | { readonly surfaceId: string; readonly status: "notRequested"; readonly capturedAt: string };

/**
 * Runner-owned final capture request. `decide()` is sampled once, synchronously, when the
 * surface cleanup starts and before the surface is closed. `record()` must not throw;
 * if it does, the outcome is dropped and cleanup continues unchanged.
 */
export interface SurfaceFinalCaptureRequest {
  decide(): SurfaceCaptureDecision;
  /** Upper bound per capture; the effective budget is also capped by half the cleanup window. */
  readonly maxTimeoutMs: number;
  record(outcome: SurfaceCaptureOutcome): void;
}

export interface BrowserCaptureWindow {
  readonly deadlineAt: number;
  readonly signal: AbortSignal | undefined;
  readonly now: () => number;
}

/** Controller hook; neither method throws or exceeds the supplied cleanup window. */
export interface BrowserFinalCaptureHook {
  capture(session: BrowserSurfaceSessionPort, window: BrowserCaptureWindow): Promise<void>;
  /** Cleanup stopped before a capture could run; recorded only if the runner asked for one. */
  skipped(reason: string): void;
}

export function createBrowserFinalCapture(surfaceId: string,
  request: SurfaceFinalCaptureRequest): BrowserFinalCaptureHook {
  let decided = false;
  const decide = (): SurfaceCaptureDecision | undefined => {
    if (decided) return undefined;
    decided = true;
    try {
      const decision = request.decide();
      return decision.requested === true && (decision.trigger === "failure" || decision.trigger === "final")
        ? Object.freeze({ requested: true, trigger: decision.trigger }) : { requested: false };
    } catch (error) {
      // A broken policy probe must not turn into a cleanup failure; record it as a capture failure.
      record(request, failure(surfaceId, "failure", `Capture decision failed: ${message(error)}`, 0));
      return undefined;
    }
  };
  return Object.freeze({
    skipped: (reason: string) => {
      const decision = decide();
      if (decision === undefined) return;
      record(request, decision.requested
        ? failure(surfaceId, decision.trigger, reason, 0)
        : Object.freeze({ surfaceId, status: "notRequested" as const, capturedAt: now() }));
    },
    capture: async (session: BrowserSurfaceSessionPort, window: BrowserCaptureWindow) => {
      const decision = decide();
      if (decision === undefined) return;
      if (!decision.requested) {
        record(request, Object.freeze({ surfaceId, status: "notRequested" as const, capturedAt: now() }));
        return;
      }
      record(request, await captureOnce(surfaceId, decision.trigger, session, window,
        request.maxTimeoutMs));
    },
  });
}

async function captureOnce(surfaceId: string, trigger: SurfaceCaptureTrigger,
  session: BrowserSurfaceSessionPort, window: BrowserCaptureWindow,
  maxTimeoutMs: number): Promise<SurfaceCaptureOutcome> {
  const startedAt = window.now();
  const elapsed = () => Math.max(0, Math.round(window.now() - startedAt));
  let method: unknown;
  try { method = session.captureScreenshot; }
  catch (error) { return failure(surfaceId, trigger, `Screenshot port is unreadable: ${message(error)}`, 0); }
  if (typeof method !== "function") {
    return Object.freeze({ surfaceId, status: "unsupported", trigger, capturedAt: now(), durationMs: 0,
      reason: "The browser surface backend does not implement captureScreenshot." });
  }
  if (window.signal !== undefined && aborted(window.signal)) {
    return failure(surfaceId, trigger, "Cleanup scope stopped before the screenshot.", 0);
  }
  // Keep at least half of the remaining cleanup window for close; never spend past the deadline.
  const timeoutMs = Math.floor(Math.min(maxTimeoutMs, (window.deadlineAt - startedAt) / 2));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    return failure(surfaceId, trigger, "No cleanup budget remained for a bounded screenshot.", 0);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<"timeout" | "stopped">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    if (window.signal !== undefined) {
      onAbort = () => resolve("stopped");
      addListener.call(window.signal, "abort", onAbort, { once: true });
    }
  });
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(Reflect.apply(method, session, [Object.freeze({
      signal: controller.signal, timeoutMs })]));
  } catch (error) { pending = Promise.reject(error); }
  // A hung or late screenshot is detached and observed; it can never reject unhandled.
  void pending.catch(() => undefined);
  try {
    const raced = await Promise.race([pending.then((value) => ({ value }),
      (error: unknown) => ({ error })), stopped]);
    if (raced === "timeout" || raced === "stopped") {
      controller.abort(new Error(`browser screenshot ${raced}`));
      return failure(surfaceId, trigger, raced === "timeout"
        ? `Screenshot did not complete within ${timeoutMs} ms.`
        : "Cleanup scope stopped during the screenshot.", elapsed());
    }
    if ("error" in raced) {
      return failure(surfaceId, trigger, `Screenshot failed: ${message(raced.error)}`, elapsed());
    }
    const bytes = receiptBytes(raced.value);
    if (bytes === undefined) {
      return failure(surfaceId, trigger, "Screenshot receipt was not non-empty image/png bytes.", elapsed());
    }
    return Object.freeze({ surfaceId, status: "captured", trigger, mediaType: "image/png", bytes,
      capturedAt: now(), durationMs: elapsed() });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined && window.signal !== undefined) {
      removeListener.call(window.signal, "abort", onAbort);
    }
  }
}

function receiptBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const media = Object.getOwnPropertyDescriptor(value, "mediaType");
  const bytes = Object.getOwnPropertyDescriptor(value, "bytes");
  if (media === undefined || !("value" in media) || media.value !== "image/png"
      || bytes === undefined || !("value" in bytes) || !(bytes.value instanceof Uint8Array)
      || bytes.value.byteLength === 0) return undefined;
  // Copy so a backend cannot mutate the bytes after the runner accepted them.
  return Uint8Array.from(bytes.value);
}

function failure(surfaceId: string, trigger: SurfaceCaptureTrigger, reason: string,
  durationMs: number): SurfaceCaptureOutcome {
  return Object.freeze({ surfaceId, status: "captureFailed", trigger,
    reason: reason.slice(0, maxReasonLength), capturedAt: now(), durationMs });
}

function record(request: SurfaceFinalCaptureRequest, outcome: SurfaceCaptureOutcome): void {
  try { request.record(outcome); } catch { /* evidence failure never changes cleanup or verdict */ }
}

function aborted(signal: AbortSignal): boolean {
  try { return Boolean(abortedGetter?.call(signal)); } catch { return true; }
}

function message(error: unknown): string {
  try { return error instanceof Error ? error.message : "unknown error"; }
  catch { return "unknown error"; }
}

function now(): string { return new Date().toISOString(); }
