import type { EvidencePolicy, SourceArtifact, TestStatus } from "@surfaceloom/reporter";

import type { CaseContext, CaseStep } from "./contracts.js";
import type { EffectDescriptor } from "./effects.js";
import type { ImageEvidenceCollectorV3 } from "./judge/image-evidence.js";
import type {
  SurfaceCaptureDecision,
  SurfaceCaptureOutcome,
  SurfaceFinalCaptureRequest,
} from "./surfaces/final-capture.js";

/** Default upper bound for one cleanup-time screenshot; also capped by half the cleanup window. */
export const finalScreenshotTimeoutMs = 2_000;

type NonCaptured = Exclude<SurfaceCaptureOutcome, { readonly status: "captured" }>;

interface CommittedOutcome {
  readonly artifactId: string;
  readonly outcome: NonCaptured;
}

/**
 * Runner-side policy for the browser surface screenshot taken before cleanup closes it.
 * It only adds evidence: it never reads or changes the Case status or failureOrigin.
 */
export class RunnerFinalCaptureV3 {
  readonly #mode: EvidencePolicy["screenshots"];
  readonly #images: ImageEvidenceCollectorV3;
  readonly #recorded: SurfaceCaptureOutcome[] = [];
  readonly #committed: CommittedOutcome[] = [];
  #isCommitted = false;
  #signal: AbortSignal | undefined;
  #failed = false;

  constructor(policy: EvidencePolicy, images: ImageEvidenceCollectorV3) {
    this.#mode = policy.screenshots;
    this.#images = images;
  }

  /**
   * Runs the runner body (surface setup + Case body) with a context whose step, criterion and
   * dispatch rejections are observed. Each of those rejections is recorded by the kernel as a
   * Case failure even when Case code catches it, so it marks the attempt as failing for the
   * cleanup-time decision, as do a body rejection and an aborted execution signal
   * (deadline/cancellation). The returned promises and the body rejection are unchanged.
   */
  async observe(base: CaseContext, body: (context: CaseContext) => Promise<void>): Promise<void> {
    this.#signal = base.signal;
    const watch = <T>(value: Promise<T>): Promise<T> => {
      void Promise.resolve(value).then(undefined, () => { this.#failed = true; });
      return value;
    };
    const context: CaseContext = Object.freeze({ ...base,
      step: <T>(step: CaseStep, run: () => T | Promise<T>) => watch(base.step(step, run)),
      criterion: <T>(id: string, check: () => T | Promise<T>) => watch(base.criterion(id, check)),
      dispatch: <T>(effect: EffectDescriptor,
        action: (authorized: Readonly<EffectDescriptor>) => T | Promise<T>) =>
        watch(base.dispatch(effect, action)),
    });
    try { await body(context); }
    catch (error) { this.#failed = true; throw error; }
  }

  readonly request: SurfaceFinalCaptureRequest = Object.freeze({
    maxTimeoutMs: finalScreenshotTimeoutMs,
    decide: () => this.decide(),
    record: (outcome: SurfaceCaptureOutcome) => {
      // Outcomes that arrive after commit (a cleanup that outlived its scope) are dropped.
      if (!this.#isCommitted) this.#recorded.push(outcome);
    },
  });

  /**
   * Assigns each recorded outcome an artifact id that no other report artifact uses, then hands
   * captured bytes to the attempt's image collector (same validation and byte budgets as Case
   * images). Call once, after cleanup and before the image collector is sealed. `reservedIds`
   * are the other artifact ids of this attempt that the image collector does not know about.
   * A Case that already used `surfaceloom.screenshot.<surfaceId>` keeps it; the runner moves.
   */
  commit(reservedIds: Iterable<string>): void {
    if (this.#isCommitted) throw new Error("Final capture outcomes were already committed.");
    this.#isCommitted = true;
    const taken = new Set(reservedIds);
    for (const outcome of this.#recorded) {
      const artifactId = this.allocate(finalScreenshotArtifactId(outcome.surfaceId), taken);
      if (outcome.status !== "captured") {
        this.#committed.push(Object.freeze({ artifactId, outcome }));
        continue;
      }
      try {
        this.#images.submitRunnerCapture({ id: artifactId, artifactId, mediaType: outcome.mediaType,
          bytes: outcome.bytes }, { title: title(outcome.trigger, outcome.surfaceId),
          phase: outcome.trigger === "failure" ? "failure" : "after",
          // Screenshots can show credentials or user data; reporters must not inline them.
          sensitive: true, durationMs: outcome.durationMs });
      } catch (error) {
        this.#committed.push(Object.freeze({ artifactId, outcome: Object.freeze({
          surfaceId: outcome.surfaceId, status: "captureFailed" as const, trigger: outcome.trigger,
          capturedAt: outcome.capturedAt, durationMs: outcome.durationMs,
          reason: `Screenshot was rejected as attempt evidence: ${message(error)}` }) }));
      }
    }
  }

  /**
   * Non-captured outcomes that belong in the report. Captured bytes already went through the
   * attempt's image collector. A cleanup-time `notRequested` is only reported when the final
   * verdict turned red anyway, so reviewers see why no image exists.
   */
  artifacts(status: TestStatus): readonly SourceArtifact[] {
    const failed = status === "failed" || status === "timedOut";
    const result: SourceArtifact[] = [];
    for (const { artifactId: id, outcome } of this.#committed) {
      if (outcome.status === "notRequested") {
        if (!failed || this.#mode !== "on-failure") continue;
        result.push(Object.freeze({ id, kind: "screenshot", phase: "failure",
          title: `Failure screenshot: ${outcome.surfaceId}`, captureStatus: "notRequested",
          contentType: "image/png", capturedAt: outcome.capturedAt, reviewPriority: "secondary",
          description: "The failure was not visible to the runner when this browser surface's "
            + "cleanup began (e.g. acceptance-criteria coverage, cleanup or Judge); "
            + "no screenshot was requested." }));
        continue;
      }
      result.push(Object.freeze({ id, kind: "screenshot",
        phase: outcome.trigger === "failure" ? "failure" : "after",
        title: title(outcome.trigger, outcome.surfaceId), captureStatus: outcome.status,
        contentType: "image/png", capturedAt: outcome.capturedAt, reviewPriority: "secondary",
        durationMs: outcome.durationMs, captureError: outcome.reason }));
    }
    return Object.freeze(result);
  }

  private allocate(base: string, taken: Set<string>): string {
    let candidate = base;
    for (let suffix = 2; taken.has(candidate) || this.#images.reserves(candidate); suffix += 1) {
      candidate = `${base}.${suffix}`;
    }
    taken.add(candidate);
    return candidate;
  }

  private decide(): SurfaceCaptureDecision {
    if (this.#mode === "off") return { requested: false };
    const failed = this.#failed || (this.#signal?.aborted ?? false);
    if (failed) return { requested: true, trigger: "failure" };
    return this.#mode === "always" ? { requested: true, trigger: "final" } : { requested: false };
  }
}

export function finalScreenshotArtifactId(surfaceId: string): string {
  return `surfaceloom.screenshot.${surfaceId}`;
}

function title(trigger: "failure" | "final", surfaceId: string): string {
  return trigger === "failure" ? `Failure screenshot: ${surfaceId}` : `Final screenshot: ${surfaceId}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}
