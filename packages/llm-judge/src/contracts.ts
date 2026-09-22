export const JUDGE_LIMITS = Object.freeze({
  maxAllowedLabels: 32,
  maxEvidenceItems: 32,
  maxQuestionChars: 4_000,
  maxTextCharsPerEvidence: 32_000,
  maxTotalTextChars: 128_000,
  maxImageBytesPerEvidence: 5 * 1024 * 1024,
  maxTotalImageBytes: 10 * 1024 * 1024,
  maxReasons: 16,
  maxObservedFacts: 32,
  maxHypotheses: 32,
} as const);

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export interface EvidenceOrigin {
  readonly kind: "serviceArtifact";
  readonly artifactId: string;
}

interface EvidenceBase {
  readonly evidenceId: string;
  readonly serviceRunId: string;
  readonly origin: EvidenceOrigin;
}

export interface TextEvidenceDescriptor extends EvidenceBase {
  readonly kind: "text";
  readonly contentType: "text/plain";
  readonly text: string;
}

/** Image bytes are supplied by the caller; providers must not fetch an origin URL. */
export interface ImageEvidenceDescriptor extends EvidenceBase {
  readonly kind: "image";
  readonly mediaType: ImageMediaType;
  readonly byteLength: number;
  readonly dataBase64: string;
}

export type EvidenceDescriptor = TextEvidenceDescriptor | ImageEvidenceDescriptor;

export interface JudgeRequest {
  readonly serviceRunId: string;
  readonly rubricVersion: string;
  readonly question: string;
  readonly allowedLabels: readonly string[];
  readonly evidence: readonly EvidenceDescriptor[];
}

export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ProviderMetadata {
  readonly provider: string;
  readonly model: string;
  readonly requestId?: string;
  readonly latencyMs?: number;
  readonly usage?: ProviderUsage;
}

export interface ObservedFact {
  /** Directly observable in cited evidence; backend causes are never observed facts. */
  readonly kind: "observed";
  readonly scope: "ui" | "artifact";
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
}

export interface Hypothesis {
  readonly kind: "hypothesis";
  readonly scope: "ui" | "artifact" | "backend";
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
  readonly verificationNeeded: string;
}

interface SupportedOutcome {
  readonly reasons: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly observedFacts: readonly ObservedFact[];
  readonly hypotheses: readonly Hypothesis[];
  readonly providerMetadata: ProviderMetadata;
}

export interface ClassifiedOutcome extends SupportedOutcome {
  readonly status: "classified";
  readonly label: string;
  readonly confidence: number;
}

export interface InsufficientOutcome extends SupportedOutcome {
  readonly status: "insufficient";
  readonly reason: string;
}

export type ProviderFailureKind =
  | "aborted"
  | "deadlineExceeded"
  | "authentication"
  | "rateLimited"
  | "server"
  | "invalidResponse"
  | "provider";

export interface ProviderFailureOutcome {
  readonly status: "providerFailure";
  readonly failure: {
    readonly kind: ProviderFailureKind;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly providerMetadata?: ProviderMetadata;
}

export type JudgeOutcome = ClassifiedOutcome | InsufficientOutcome | ProviderFailureOutcome;

export interface JudgeInvocation {
  /** Absolute Unix epoch milliseconds. */
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
}

export interface JudgeProviderContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

/** Unknown is deliberate: the judge validates every provider response at runtime. */
export interface JudgeProvider {
  readonly name: string;
  judge(request: JudgeRequest, context: JudgeProviderContext): Promise<unknown>;
}

export class JudgeContractError extends Error {
  readonly code = "INVALID_JUDGE_CONTRACT";

  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "JudgeContractError";
  }
}

export class JudgeProviderError extends Error {
  constructor(
    readonly kind: Exclude<ProviderFailureKind, "aborted" | "deadlineExceeded" | "invalidResponse">,
    message: string,
    readonly retryable: boolean,
    readonly providerMetadata?: ProviderMetadata,
  ) {
    super(message);
    this.name = "JudgeProviderError";
  }
}
