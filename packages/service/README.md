# @surfaceloom/service

Local service primitives that let an Agent discover and run registered SurfaceLoom tests at an exact
Git revision, disconnect, and retrieve the durable result later.

## What is implemented

- `TestCatalog` publishes bounded, immutable test definitions and parameter schemas.
- `LocalGitWorkspaceProvider` prepares detached, read-only snapshots from preconfigured local sources.
- `CommandExecutor` runs only registered executable/argv combinations with `shell: false`.
- `SurfaceLoomV3Executor` runs one exactly registered Case through the public `runCaseV3` kernel and
  persists the complete Reporter v3 bundle without creating a second runner.
- `FileRunStore` and `FileArtifactStore` persist run identity, state, cleanup receipts, and verified
  artifact bytes for one local service process.
- `AgentTestService` joins catalog, workspace, executor, and persistence without creating another test
  runner.
- The MCP adapter uses the official TypeScript SDK v2 and exposes a loopback Streamable HTTP endpoint.

The MCP server provides seven tools:

| Tool | Purpose |
| --- | --- |
| `catalog` | List registered tests, parameters, effects, and requirements |
| `prepare` | Prepare a configured source at an exact revision |
| `status` | Read a prepare operation, a run, or a run by caller `requestId` |
| `run` | Persist and start one registered test |
| `get_result` | Read current state and the terminal result |
| `get_artifact` | Read a bounded base64 artifact chunk |
| `cancel` | Explicitly cancel a run |

## Embedding the MCP endpoint

The host application owns configuration and constructs the catalog, provider, executor, and stores.
Only public `sourceKey` values cross MCP; callers cannot submit arbitrary filesystem paths or shell
commands.

```ts
import {
  AgentTestService,
  FileArtifactStore,
  FileRunStore,
  PersistentRunService,
  TestCatalog,
} from "@surfaceloom/service";
import {
  createSurfaceLoomMcpHandler,
  listenSurfaceLoomMcp,
} from "@surfaceloom/service/mcp";

const runs = await PersistentRunService.create({
  runStore: await FileRunStore.open(".surfaceloom/runs"),
  artifactStore: await FileArtifactStore.open(".surfaceloom/artifacts"),
  executor,
  workspaceLifecycle: workspaceProvider,
});

const service = new AgentTestService({
  catalog: new TestCatalog(testDefinitions),
  runs,
  workspaceProvider,
  workspaceSources: {
    repository: { provider: workspaceProvider.id, locator: "configured-repository" },
  },
});

const endpoint = await listenSurfaceLoomMcp(createSurfaceLoomMcpHandler(service));
console.log(endpoint.url.href); // http://127.0.0.1:<port>/mcp
```

Use a stable, caller-generated `requestId` for `run`. Repeating the same request returns the original
`runId`; reusing it with different snapshot, test, parameters, or task identity is rejected. Closing
the MCP client does not cancel submitted work. Reconnect and query `status` by `requestId`, or call
`cancel` explicitly.

Tests with `externalEffect` or `securitySensitive` effect levels require an exact
`acknowledgedEffect` value on `run`.

## Registering a v3 Case

The host registers trusted Case definitions and backend options. The executor supplies the service
`runId`, cancellation signal, and private staging/report paths, so MCP callers cannot replace those
identities or paths.

```ts
import path from "node:path";
import { FileArtifactStore, SurfaceLoomV3Executor } from "@surfaceloom/service";

const artifactStore = await FileArtifactStore.open(".surfaceloom/artifacts");
const executor = new SurfaceLoomV3Executor("surfaceloom.v3", {
  artifactStore,
  workRoot: path.resolve(".surfaceloom/v3-work"),
  registrations: [{
    testId: "service-test:login/smoke",
    caseSpecId: loginCase.spec.id,
    resolve: () => ({ definition: loginCase, options: trustedRunnerOptions }),
  }],
});
```

The matching `TestDefinition` must use `runtime.kind: "surfaceloom-v3"` and reference exactly that
one `CaseSpec`. `get_result` then exposes the CaseSpec correlation, while `get_artifact` returns the
bounded `report.json`, `index.html`, `ai-review.md`, `complete.json`, and evidence files.

## Current boundary

This implementation is intentionally local and small:

- the HTTP listener accepts only `127.0.0.1` or `::1` and validates local Host/Origin headers;
- the file stores support one service process, not multiple writers or a distributed scheduler;
- run/artifact records survive restart, while in-flight prepare-operation state does not;
- unfinished runs found after restart become `interrupted` and tainted instead of being executed again;
- credentials must not be placed in Case parameters, artifacts, or catalog metadata;
- remote authentication, retention policy, and deployment isolation belong to the embedding service;
- each v3 service test currently maps to exactly one registered Case; it is not a suite scheduler;
- the package remains private until the repository's packed-consumer and release gates are complete.

The package test suite includes official MCP client reconnect, response-loss retry, explicit cancel,
artifact retrieval, a real registered Node command, and an MCP-to-v3-kernel-to-Reporter round trip.
