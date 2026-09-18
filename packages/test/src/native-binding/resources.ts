import { performance as nodePerformance } from "node:perf_hooks";
import type { CaseContext } from "../contracts.js";
import type { InteractiveSessionLease } from "../interactive-session-contracts.js";
import type {
  NativeBindingPort,
  NativeCleanupProof,
  NativeCleanupReceipt,
  NativeHostHandshake,
  NativeSessionIdentity,
} from "./contracts.js";
import { validateCleanupBudget } from "./cleanup-budget.js";

type SettledSession =
  | { readonly status: "acquired"; readonly session: NativeSessionIdentity }
  | { readonly status: "unknown"; readonly reason: string };
type LayerResult = NativeCleanupReceipt | { readonly status: "notApplicable" };
type ClockRead = { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: string };
const systemNow = nodePerformance.now.bind(nodePerformance);

/** Registered before acquisition; unknown launch can be boundedly reconciled. */
export class DeferredNativeAcquisition {
  readonly #settled: Promise<SettledSession>;
  #settle!: (value: SettledSession) => void;
  #done = false;

  constructor() { this.#settled = new Promise((resolve) => { this.#settle = resolve; }); }
  acquired(session: NativeSessionIdentity): void { this.finish({ status: "acquired", session }); }
  unknown(reason: string): void { this.finish({ status: "unknown", reason }); }
  settled(): Promise<SettledSession> { return this.#settled; }

  reconcile(task: () => Promise<NativeSessionIdentity | null>, timeoutMs: number,
    validate: (session: NativeSessionIdentity) => void): void {
    if (this.#done) return;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    void Promise.race([Promise.resolve().then(task), timeout]).then((session) => {
      if (session === null) { this.unknown("Late acquisition reconciliation was unconfirmed."); return; }
      try { validate(session); this.acquired(session); }
      catch (error) { this.unknown(message(error)); }
    }, (error: unknown) => this.unknown(`Late acquisition reconciliation failed: ${message(error)}`));
  }

  private finish(value: SettledSession): void {
    if (this.#done) return;
    this.#done = true;
    this.#settle(Object.freeze(value));
  }
}

class CleanupLayer {
  readonly promise: Promise<LayerResult>;
  #resolve!: (value: LayerResult) => void;
  #started = false;
  #value: LayerResult | undefined;
  constructor(applicable: boolean, readonly timeoutMs: number, readonly label: string,
    readonly retainFailure: (reason: string) => void, readonly clock: ValidatedCleanupClock) {
    this.promise = new Promise((resolve) => { this.#resolve = resolve; });
    if (!applicable) { this.#started = true; this.finish(Object.freeze({ status: "notApplicable" })); }
  }
  run(task: () => Promise<LayerResult>): Promise<LayerResult> {
    if (!this.#started) {
      this.#started = true;
      const started = this.clock.read();
      if (!started.ok) {
        this.finish(unconfirmed(`${this.label} cleanup clock failed: ${started.reason}`));
        void Promise.resolve().then(task).catch(() => undefined);
        return this.promise;
      }
      const deadlineAt = started.value + this.timeoutMs;
      const timer = setTimeout(() => this.finish(unconfirmed(`${this.label} cleanup timed out.`)), this.timeoutMs);
      void Promise.resolve().then(task).then((value) => {
        clearTimeout(timer);
        this.finish(this.completion(value, deadlineAt));
      }, (error: unknown) => {
        clearTimeout(timer);
        this.finish(this.completion(unconfirmed(`${this.label} cleanup failed: ${message(error)}`), deadlineAt));
      });
    }
    return this.promise;
  }
  snapshot(): LayerResult | undefined { return this.#value; }
  private completion(value: LayerResult, deadlineAt: number): LayerResult {
    const completed = this.clock.read();
    if (!completed.ok) return unconfirmed(`${this.label} cleanup clock failed: ${completed.reason}`);
    return completed.value < deadlineAt ? value : unconfirmed(`${this.label} cleanup timed out.`);
  }
  private finish(value: LayerResult): void {
    if (this.#value !== undefined) return;
    this.#value = value;
    if (value.status === "unconfirmed") this.retainFailure(value.reason);
    this.#resolve(value);
  }
}

class ValidatedCleanupClock {
  #last: number | undefined;
  constructor(readonly now: () => number) {}
  read(): ClockRead {
    let value: number;
    try { value = this.now(); }
    catch { return { ok: false, reason: "clock threw" }; }
    if (!Number.isFinite(value)) return { ok: false, reason: "clock returned a non-finite value" };
    if (this.#last !== undefined && value < this.#last) {
      return { ok: false, reason: "clock moved backwards" };
    }
    this.#last = value;
    return { ok: true, value };
  }
}

export function registerNativeResources(options: {
  readonly context: CaseContext;
  readonly acquisition: DeferredNativeAcquisition;
  readonly handshake: NativeHostHandshake;
  readonly port: NativeBindingPort;
  readonly targetOwnership: NativeSessionIdentity["ownership"];
  readonly ownsProtocol: boolean;
  readonly ownsHost: boolean;
  readonly resourceNamespace?: string;
  readonly registerHostResource?: boolean;
  readonly cleanupSettleTimeoutMs: number;
  readonly cleanupClock?: () => number;
  readonly lease?: InteractiveSessionLease;
}): void {
  const cleanupSettleTimeoutMs = validateCleanupBudget(options.cleanupSettleTimeoutMs);
  const namespace = validateResourceNamespace(options.resourceNamespace ?? "native");
  const state = { reason: "" };
  const retainReason = (reason: string): void => mark(state, reason);
  const clock = new ValidatedCleanupClock(options.cleanupClock ?? systemNow);
  const target = new CleanupLayer(options.targetOwnership === "owned",
    cleanupSettleTimeoutMs, "Target", retainReason, clock);
  const protocol = new CleanupLayer(options.ownsProtocol,
    cleanupSettleTimeoutMs, "Protocol", retainReason, clock);
  const host = new CleanupLayer(options.ownsHost,
    cleanupSettleTimeoutMs, "Host", retainReason, clock);
  const protocolPrior = target;
  const hostPrior = options.ownsProtocol ? protocol : target;
  const tail = options.ownsHost ? host : options.ownsProtocol ? protocol : target;

  if (options.lease !== undefined) {
    options.context.registerResource({ id: `${namespace}.gui-lease.${options.lease.leaseToken}`,
      ownership: "owned", cleanup: async () => {
        const result = tail.snapshot();
        if (result === undefined) {
          mark(state, "Native cleanup barrier did not settle before GUI lease cleanup.");
          return unconfirmed(state.reason);
        }
        if (result.status === "unconfirmed" || state.reason !== "") {
          return unconfirmed(state.reason
            || (result.status === "unconfirmed" ? result.reason : "Native cleanup unconfirmed."));
        }
        return options.lease!.release();
      } });
  }
  options.context.registerResource({ id: `${namespace}.cleanup-barrier`, ownership: "owned", cleanup: async () => {
    const result = tail.snapshot();
    if (result === undefined) {
      mark(state, "Native cleanup remained pending at the cleanup barrier.");
      return unconfirmed(state.reason);
    }
    if (result.status === "unconfirmed") mark(state, result.reason);
    return state.reason === "" ? released() : unconfirmed(state.reason);
  } });
  registerHost(options, host, hostPrior, state, namespace);
  registerProtocol(options, protocol, protocolPrior, state, namespace);
  registerTarget(options, target, state, namespace);
}

function registerTarget(options: Parameters<typeof registerNativeResources>[0], layer: CleanupLayer,
  state: { reason: string }, namespace: string): void {
  if (options.targetOwnership === "borrowed") {
    options.context.registerResource({ id: `${namespace}.target`, ownership: "borrowed" }); return;
  }
  options.context.registerResource({ id: `${namespace}.target`, ownership: "owned", cleanup: () => layer.run(async () => {
    const acquired = await options.acquisition.settled();
    const result = acquired.status === "acquired"
      ? await proof(() => options.port.cleanupTarget(acquired.session), (item) => targetMatches(item, acquired.session), "target exit")
      : unconfirmed(acquired.reason);
    return retain(state, result);
  }).then(asReceipt) });
}

function registerProtocol(options: Parameters<typeof registerNativeResources>[0], layer: CleanupLayer,
  prior: CleanupLayer, state: { reason: string }, namespace: string): void {
  if (!options.ownsProtocol) {
    options.context.registerResource({ id: `${namespace}.protocol`, ownership: "borrowed" }); return;
  }
  options.context.registerResource({ id: `${namespace}.protocol`, ownership: "owned", cleanup: () => layer.run(async () => {
    const earlier = await prior.promise;
    const acquired = await options.acquisition.settled();
    const own = acquired.status === "acquired"
      ? await proof(() => options.port.releaseProtocol(acquired.session),
        (item) => protocolMatches(item, acquired.session), "session release")
      : unconfirmed(acquired.reason);
    return retain(state, combine(earlier, own));
  }).then(asReceipt) });
}

function registerHost(options: Parameters<typeof registerNativeResources>[0], layer: CleanupLayer,
  prior: CleanupLayer, state: { reason: string }, namespace: string): void {
  if (options.registerHostResource === false) return;
  if (!options.ownsHost) {
    options.context.registerResource({ id: `${namespace}.host`, ownership: "borrowed" }); return;
  }
  options.context.registerResource({ id: `${namespace}.host`, ownership: "owned", cleanup: () => layer.run(async () => {
    const earlier = await prior.promise;
    const own = await proof(() => options.port.closeHost(),
      (item) => hostMatches(item, options.handshake), "host child exit");
    return retain(state, combine(earlier, own));
  }).then(asReceipt) });
}

async function proof(task: () => Promise<NativeCleanupProof | void>,
  matches: (proof: NativeCleanupProof) => boolean, label: string): Promise<NativeCleanupReceipt> {
  try {
    const value = await task();
    if (value === undefined || !matches(value)) return unconfirmed(`Missing or mismatched ${label} proof.`);
    return released();
  } catch (error) { return unconfirmed(`${label} cleanup failed: ${message(error)}`); }
}

function targetMatches(proof: NativeCleanupProof, session: NativeSessionIdentity): boolean {
  return proof.kind === "targetExit" && proof.hostInstanceId === session.hostInstanceId
    && proof.sessionId === session.sessionId && proof.targetIdentity === session.targetIdentity;
}
function protocolMatches(proof: NativeCleanupProof, session: NativeSessionIdentity): boolean {
  return proof.kind === "sessionRelease" && proof.hostInstanceId === session.hostInstanceId
    && proof.sessionId === session.sessionId;
}
function hostMatches(proof: NativeCleanupProof, host: NativeHostHandshake): boolean {
  return proof.kind === "hostChildExit" && proof.hostInstanceId === host.hostInstanceId
    && proof.hostChildIdentity === host.hostChildIdentity;
}
function combine(left: LayerResult, right: NativeCleanupReceipt): NativeCleanupReceipt {
  return left.status === "unconfirmed" ? left : right;
}
function asReceipt(value: LayerResult): NativeCleanupReceipt {
  return value.status === "notApplicable" ? released() : value;
}
function retain(state: { reason: string }, value: LayerResult): LayerResult {
  if (value.status === "unconfirmed") mark(state, value.reason);
  return value;
}
function mark(state: { reason: string }, reason: string): void { state.reason ||= reason; }
function validateResourceNamespace(value: string): string {
  if (value.length === 0 || value.length > 512
      || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)) {
    throw new Error("Native resource namespace must be a stable identifier.");
  }
  return value;
}
function released(): NativeCleanupReceipt { return Object.freeze({ status: "released" }); }
function unconfirmed(reason: string): NativeCleanupReceipt { return Object.freeze({ status: "unconfirmed", reason }); }
function message(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }
