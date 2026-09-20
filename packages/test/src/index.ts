export type {
  CaseContext, CaseDefinition, CaseStep, ExecuteCaseOptions, ExecutionCancellationContext,
} from "./contracts.js";
export { CaseRegistry, defineCase } from "./definition.js";
export { executeCase } from "./execute.js";
export { defineCaseV3 } from "./definition-v3.js";
export { runCaseV3 } from "./runner-v3.js";
export { RunCaseV3Error } from "./runner-v3-error.js";
export type {
  ExecutionGuiGate, WindowsExecutionGuiGateOptions, WindowsExecutionGuiGateQuarantineIdentity,
  WindowsExecutionGuiGateRecoveryProof,
} from "./execution-gate.js";
export {
  acquireWindowsExecutionGuiGate, observeWindowsExecutionGuiGateQuarantine,
  recoverWindowsExecutionGuiGateQuarantine,
} from "./execution-gate.js";
export type { RunCaseV3AdditionalFailure, RunCaseV3FailurePhase } from "./runner-v3-error.js";
export type {
  BrowserRunnerSurfaceV3,
  CaseContextV3,
  CaseDefinitionV3Input,
  CaseDefinitionV3,
  CaseEvidenceSubmissionV3,
  CaseEvidenceV3,
  CaseSurfaceV3,
  NativeRunnerSurfaceV3,
  RunnerSurfaceV3,
  RunCaseV3Identity,
  RunCaseV3Options,
  RunCaseV3Result,
} from "./runner-v3-contracts.js";
export type {
  CaseImageEvidenceSubmissionV3,
  JudgeCriterionV3,
  JudgeRunnerBindingV3,
} from "./judge/contracts.js";
export type {
  AxAction, AxLocator, BrowserAction, BrowserCloseProof, BrowserSurfaceAuthor,
  BrowserSurfaceBackendPort, BrowserSurfaceRequirement, BrowserSurfaceSessionPort,
  DomLocator, NativeSurfaceAuthor, NativeSurfaceRequirement, SurfaceBackendCall, SurfaceOwnership,
  UiaAction, UiaLocator,
} from "./surfaces/contracts.js";
export type { SurfaceProviderErrorCode } from "./surfaces/errors.js";
export { SurfaceProviderError } from "./surfaces/errors.js";
export type {
  AssertionClock,
  AssertionFailure,
  CompletenessRequirement,
  ObservationAssertionOptions,
  ObservationAssertionResult,
  ObservationExpectation,
} from "./assertion-contracts.js";
export { assertObservation, ObservationAssertionError, waitForObservation } from "./assertion.js";
export type {
  AgentApprovalObservation,
  AgentAssertionOptions,
  AgentCallScope,
  AgentCompletionAssertionOptions,
  AgentExternalEffectObservation,
  AgentObservationProvider,
  AgentResourceScope,
  AgentRunScope,
  AgentRunStateObservation,
  AgentToolCallObservation,
  NoExternalEffectAssertionOptions,
} from "./agent-observation.js";
export {
  assertAgentApprovalRequested,
  assertAgentResourceHasNoExternalEffect,
  assertAgentRunState,
  assertAgentToolCall,
  assertAgentToolCallExactlyOnce,
} from "./agent-observation.js";
export {
  assertAgentRunState as toHaveRunState,
  assertAgentApprovalRequested as toHaveRequestedApproval,
  assertAgentToolCall as toHaveToolCall,
  assertAgentToolCallExactlyOnce as toHaveExecutedExactlyOnce,
  assertAgentResourceHasNoExternalEffect as toHaveNoExternalEffect,
} from "./agent-observation.js";
export type {
  AgentAssertionDefaults,
  AgentAuthorAssertionOptions,
  AgentAuthorCompletionOptions,
  AgentResource,
  AgentResourceExpectation,
  AgentRun,
  AgentRunBinding,
  AgentRunExpectation,
  AgentTool,
  AgentToolBinding,
  AgentToolExpectation,
} from "./agent-author.js";
export { bindAgentRun, expectAgent } from "./agent-author.js";
export type {
  Observation,
  ObservationAttempt,
  ObservationCompleteness,
  ObservationReadContext,
  ObservationReader,
  ObservationSnapshot,
} from "./observation.js";
export type { EffectDescriptor } from "./effects.js";
export { defineEffect, effectSideEffectLevel } from "./effects.js";
export type {
  ExecutionEnvironment,
  ExecutionPlan,
  ExecutionPlanInput,
  ExecutionRequirements,
  HostOS,
  SurfaceCapabilities,
  SurfaceKind,
} from "./plan-contracts.js";
export type { ExecutionPolicyErrorCode } from "./plan-errors.js";
export { ExecutionPolicyError } from "./plan-errors.js";
export { defineExecutionPlan } from "./plan.js";
export type { EffectGrant, ExecutionEffectPolicy } from "./policy-contracts.js";
export { ExecutionPolicyGate, preflightExecution } from "./policy.js";
export type {
  DeadlineCancellation, DeadlineTaskContext, DeadlineTaskOptions, DeadlineTaskOutcome,
  DeadlineTaskSnapshot, ExecutionClock, TaskSettleReceipt,
} from "./deadline-contracts.js";
export { DeadlineCancellationError, startDeadlineTask } from "./deadline.js";
export type {
  ResourceCleanupOutcome, ResourceCleanupReceipt, ResourceCleanupResult, ResourceFailure,
  ResourceCleanupBoundary, ResourceCleanupRemaining, ResourceFailureCode,
  ResourceRegistration, ResourceScopeOptions,
} from "./resources-contracts.js";
export { ResourceScope } from "./resources.js";
export type {
  InProcessWorkerHandle, NodeWorkerHandle, OwnedNodeWorkerOptions, WorkerFailure,
  WorkerFailureCode, WorkerSettlementSummary, WorkerStopSnapshot, WorkerStopState,
  WorkerTrackingHandle, WorkerTrackingOptions,
} from "./worker-contracts.js";
export { trackInProcessTask } from "./worker.js";
export { trackNodeWorker } from "./worker-node.js";
export type {
  AcquireInteractiveSessionLeaseOptions,
  InteractiveSessionLease,
  InteractiveSessionLeaseClaim,
  InteractiveSessionLeaseDiagnostic,
  InteractiveSessionLeaseErrorCode,
  InteractiveSessionReleaseReceipt,
} from "./interactive-session-contracts.js";
export {
  acquireInteractiveSessionLease,
  InteractiveSessionLeaseError,
  releaseInteractiveSessionLease,
} from "./interactive-session.js";
export type {
  ProjectDefinition,
  ProjectDefinitionInput,
  ProjectInvocationOverrides,
  ProjectModuleFormat,
  ResolvedProject,
  ResolveProjectOptions,
} from "./project-contracts.js";
export {
  defineProject,
  preflightResolvedProject,
  ProjectConfigurationError,
  resolveProject,
} from "./project.js";
export type {
  CaseModuleFormat,
  CaseModuleLanguage,
  CaseModuleLoadRequest,
  LoadedProjectCases,
  ProjectCaseLoaderOptions,
  TypeScriptCaseRuntime,
} from "./loader-contracts.js";
export { loadProjectCases, ProjectLoadError } from "./loader.js";
export * from "./native-binding/index.js";
export * from "./cli/index.js";
export * from "./report/index.js";
