import {
  bindAgentRun,
  defineCaseV3,
  expectAgent,
  runCaseV3,
  SurfaceProviderError,
  type AgentObservationProvider,
  type BrowserSurfaceBackendPort,
  type BrowserSurfaceSessionPort,
  type RunCaseV3Options,
} from "@surfaceloom/test";

const runId = "run-000001";
const callId = "run-000001:call-1";
const barrier = { kind: "barrier" as const, id: "reference.run-000001.done" };

const provider: AgentObservationProvider = {
  readRunState: (scope) => ({ state: "available", value: { ...scope, state: "completed" } }),
  readApproval: (scope) => ({ state: "available", value: { ...scope, requested: true } }),
  readToolCall: (scope) => ({ state: "available", value: {
    ...scope, requested: 1, started: 1, completed: 1,
  }, completeness: { ...barrier, complete: true } }),
  readExternalEffects: (scope) => ({ state: "available", value: {
    ...scope, boundary: "external", count: 0,
  }, completeness: { ...barrier, complete: true } }),
};

const agentRun = bindAgentRun({ provider, runId, approvalCallId: callId,
  tools: [{ toolId: "write-note", callId }], assertion: { timeoutMs: 1_000 } });

const backend: BrowserSurfaceBackendPort = {
  hostId: "browser-host",
  capabilities: ["browser.dom.inspect"],
  async launch(_requirement, call): Promise<BrowserSurfaceSessionPort> {
    call.beforeSubmit();
    return {
      identity: { hostId: "browser-host", sessionId: "session-1" },
      async invoke(action, operation) {
        const submission = operation.beforeSubmit();
        if (submission.signal.aborted) {
          throw new SurfaceProviderError("unknownOutcome", "Browser stopped after submission.");
        }
        if (action.kind === "readText") return "completed";
        return undefined;
      },
      async close() {
        return { kind: "browserSessionClosed", hostId: "browser-host", sessionId: "session-1" };
      },
    };
  },
};

const definition = defineCaseV3({
  spec: {
    id: "reference.public.author",
    locale: "zh-CN",
    platforms: ["web"],
    suite: { id: "reference.public", name: "公开作者契约" },
    name: "公开入口可编写案例",
    intent: "验证产品适配器和案例作者只依赖公开包入口。",
    preconditions: [{ id: "fixture-ready", text: "参考服务已启动。" }],
    acceptanceCriteria: [{ id: "agent-verified", text: "工具调用和审批均已验证。" }],
    sideEffect: "readOnly",
  },
  async run(context) {
    const surface = context.surface("page");
    if (surface.kind !== "browser") throw new Error("Expected browser.");
    await surface.perform({ kind: "readText", locator: {
      kind: "testId", key: "run.status", value: "run.status",
    } });
    await context.criterion("agent-verified", async () => {
      await expectAgent(agentRun).toHaveRequestedApproval();
      await expectAgent(agentRun.tool("write-note")).toHaveExecutedExactlyOnce({ barrier });
    });
  },
});

function executeThroughExistingKernel(options: RunCaseV3Options) {
  return runCaseV3(definition, options);
}

void backend;
void definition;
void executeThroughExistingKernel;
