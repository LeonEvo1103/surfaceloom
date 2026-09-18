# @surfaceloom/native protocol contract

This package owns the product-neutral native wire protocol schema, golden vectors, TypeScript client,
bounded Node child-process transport, typed desktop-session contracts, and thin platform bindings. The
Windows binding maps the existing `surfaceloom.native/1.0` Windows host; it does not reimplement UIA and
does not by itself establish live UIA conformance.

## TypeScript client

`NativeClient` negotiates one immutable host connection over an injected byte transport. The transport owns
process or socket I/O; the client owns framing, correlation, deadlines, cancellation requests, capability
checks, and host/session/handle identity. Platform packages provide result codecs and method payloads rather
than adding UIA, AX, or DOM semantics here.

```ts
import {
  NativeClient,
  NodeProcessTransport,
  jsonResultCodec,
} from "@surfaceloom/native";

const transport = new NodeProcessTransport({
  executable: "/absolute/path/to/a/surfaceloom-native-host",
  cwd: "/absolute/host-working-directory",
  env: {},
});

const client = new NativeClient({ transport });
const host = await client.connect();

const result = await client.invoke({
  name: "example.observe",
  intent: "observe",
  scope: { kind: "host", hostInstanceId: host.hostInstanceId },
  payload: {},
  timeoutMs: 1_000,
  codec: jsonResultCodec,
});

await client.close();
```

`NodeProcessTransport` can launch an explicitly configured native host with `shell: false`, bounded framing,
write admission, stderr retention, startup/write/close deadlines, and separate process-exit and stdio-close
facts. Its exit receipt proves only the owned host child state, not target-application or descendant cleanup.

The client never automatically replays a request. A cancellation frame is best effort and does not prove
that native work stopped. Request, operation, and cancellation identifiers are not reused within a client
lifetime; late terminal responses therefore remain recognizable. The current evidence is contract testing
against fake transports plus adversarial real child processes. Real UI host conformance is tracked separately.

## Version and frame boundary

- Protocol name: `surfaceloom.native`; initial exact wire version: `1.0`.
- Transport framing is UTF-8 NDJSON: exactly one JSON object per line, at most 1 MiB including LF.
- Every message carries `protocol`, `version`, `type`, and a bounded correlation `id`. Unknown top-level
  fields and unsupported versions fail before call payload dispatch.
- A host may return a version-mismatch diagnostic using its own supported version when it can safely recover
  the request id, but must not dispatch an unsupported request. Version negotiation is not optimistic parsing.
- Breaking field or semantic changes require a new major version. A new optional feature still requires an
  advertised namespaced method; receivers never infer support from a higher minor version.

Windows NDJSON `0.2` remains an isolated legacy route, not an alias or compatibility version of this
protocol. The Windows TypeScript binding uses only the host's separate `surfaceloom.native/1.0` route and
never falls back to `0.2`.

## Windows binding

`@surfaceloom/native/windows` exposes a typed controller and session over the existing Windows v1 host.
The host executable and working directory are mandatory absolute paths: there is no PATH discovery,
download, build-on-demand, or legacy-protocol fallback.
Launch acquisition always waits for a root window. `waitForWindow: false` is rejected before host startup or
wire submission because the v1 host cannot bind a process-only launch to a trustworthy root UIA identity.

```ts
import { WindowsNativeController } from "@surfaceloom/native/windows";

const controller = new WindowsNativeController({
  hostId: "windows.local",
  process: {
    executable: "C:\\absolute\\path\\SurfaceLoom.WindowsHost.exe",
    cwd: "C:\\absolute\\path",
  },
});

const host = await controller.connect();
const session = await controller.attach({ processId: 1234 });
// Strict locators reject an empty selector and matchIndex.
const result = await session.find({
  automationIds: ["display-name"], names: [], controlTypes: ["edit"],
  classNames: [], frameworkIds: [], nativeWindowHandle: null,
  scope: "descendants", matchIndex: null,
});
await session.cleanupPort.release();
await controller.close();
```

`launch()` returns an owned `ApplicationDesktopSession` with `lifecyclePort`; `attach()` returns a borrowed
session whose public type exposes release but no close or terminate authority. Both expose the shared
`surface`, `backend`, `nativeIdentity`, `nativeActions`, `operationPort`, `evidence`, and `cleanupPort` fields.

The controller validates both handshake identity (`platform: windows`, `backend: uia`) and the
`capabilities.get` identity (`backend: windows-ui-automation`). Effective capabilities are the intersection
of implemented operations, host methods/features, and the configured environment. Handles retain their
full host/session/element tuple; checked actions carry the original strict locator, root, and process id.
Remote operation receipts, including `unknown`, are preserved without replay.

`@surfaceloom/native/windows/v3` is an optional bridge to `@surfaceloom/test`. Configure stable target ids
separately from absolute launch paths or attach PIDs, then inject the returned plain backend object into a
v3 native surface. Importing the root or `/windows` entrypoint does not load `@surfaceloom/test`; the v3
entrypoint requires the matching optional peer.

The scoped evidence for this entrypoint uses a real Node child process speaking scripted v1 NDJSON and a
real v3 runner Case. Actual Node→Windows host→WPF/UIA execution remains the separate P3-060 live gate.

## Calls, scope, and ownership

A request call has a namespaced method, `observe | mutate | lifecycle` intent, relative deadline, explicit
scope, and JSON payload owned by that advertised method. This base protocol does not flatten AX, UIA, DOM,
or product locators into one selector type.

The handshake advertises method descriptors containing `name`, fixed `intent`, and allowed `scopeKinds`.
Both sides reject a call whose declared intent or scope differs from that descriptor. Shared reserved methods
also enforce their contract before negotiation: `host.handshake` is observe/bootstrap and `session.launch` is
lifecycle/host. A caller cannot label a side effect as an observation to bypass operation receipts.

Scopes are hierarchical:

1. `bootstrap` is valid only for initial host discovery methods.
2. `host` is bound to one `hostInstanceId`; restart invalidates it.
3. `session` adds `sessionId`.
4. `handle` adds `handleId`; the full `(hostInstanceId, sessionId, handleId)` tuple is the identity.

Handles never float across sessions and must never fall back to a host or desktop root when stale. Session
descriptors use `owned` or `borrowed`: `release` is valid for either; `close`/`terminate` require `owned`.
System sessions are always borrowed. EOF cleanup may clean owned resources but must not affect borrowed ones.

## Deadline and cancellation

`deadline.timeoutMs` is a relative budget that starts when the complete frame arrives. Protocol/version and
schema validation, queueing, operation, and response construction all consume that same budget; validation
does not receive free time. It is not a wall-clock timestamp and does not assume synchronized clocks. Zero
means the call must not start.

A `cancel` frame names a different outstanding request id. Cancellation is a request, not proof of stop. The
original request still owns the terminal response when the connection survives. Once native submission may
have begun, timeout/cancellation cannot produce `notExecuted` without a trustworthy backend receipt.

## Errors and operation outcome

Errors are bounded, structured metadata: stable `code`, category, safe message, retry disposition, and
optional JSON details. Arbitrary element snapshots, values, paths, or application content do not belong in
an error.

Every `mutate` or `lifecycle` request carries a unique `operationId`; its response carries the same id and one
outcome:

- `notExecuted`: trusted evidence proves the submission boundary was never crossed.
- `executed`: trusted evidence proves the operation committed. A successful side-effecting response requires it.
- `unknown`: submission may have occurred but completion cannot be proven.

`operationId` is correlation evidence, not an idempotency key. `executed` and `unknown` are never safe to
retry. On a write failure, a client reports `notExecuted` only before any bytes were written; partial or fully
written requests are `unknown`. Observation/postcondition polling may continue, but must not replay the action.

## Golden vectors

`vectors/v1/*.vector.json` are executable examples. Each contains one exact message and its expected schema
result. Contract tests also exercise cross-message correlation, ownership, handle scope, framing, deadline,
cancellation, and disconnect classification. These vectors establish only protocol contract coverage, not a
Windows/macOS live capability.
