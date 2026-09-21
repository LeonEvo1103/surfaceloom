# @surfaceloom/service

Local service primitives for submitting registered SurfaceLoom tests and reading their results later.

The first persistent implementation is intentionally small:

- `FileRunStore` keeps run metadata in one atomically replaced `runs.json` file.
- `FileArtifactStore` keeps bounded artifact bytes by SHA-256 plus small manifests.
- `PersistentRunService` persists a run before dispatch, deduplicates caller `requestId` values,
  exposes status/cancel/artifact operations, and marks unfinished runs interrupted and tainted after
  restart.

It is a single-service-process store for a local test machine. It is not a distributed scheduler or
database abstraction. Parameters and artifacts are persisted locally, so callers must not put
credentials in Case parameters and should apply their own retention policy to the store directory.

```ts
const runs = await FileRunStore.open(".surfaceloom/runs");
const artifacts = await FileArtifactStore.open(".surfaceloom/artifacts");
const service = await PersistentRunService.create({ runStore: runs, artifactStore: artifacts, executor });

const started = await service.start({
  requestId: "ci-login-existing-42",
  snapshot,
  testId,
  parameters,
  definition,
  workspace,
});

const result = await service.wait(started.runId);
```

An MCP adapter and SurfaceLoom v3 executor are separate follow-up tasks. Transport disconnect does not
cancel a run; callers cancel explicitly by `runId`.
