# @surfaceloom/native protocol contract

This package owns the product-neutral native wire protocol schema, golden vectors, and transport-neutral
TypeScript client. It deliberately contains no host launcher, UIA/AX implementation, or live conformance claim.

## TypeScript client

`NativeClient` negotiates one immutable host connection over an injected byte transport. The transport owns
process or socket I/O; the client owns framing, correlation, deadlines, cancellation requests, capability
checks, and host/session/handle identity. Platform packages provide result codecs and method payloads rather
than adding UIA, AX, or DOM semantics here.

```ts
import { NativeClient, jsonResultCodec } from "@surfaceloom/native";

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

The client never automatically replays a request. A cancellation frame is best effort and does not prove
that native work stopped. Request, operation, and cancellation identifiers are not reused within a client
lifetime; late terminal responses therefore remain recognizable. The current evidence is contract testing
against fake transports. Real host conformance is tracked separately.

## Version and frame boundary

- Protocol name: `surfaceloom.native`; initial exact wire version: `1.0`.
- Transport framing is UTF-8 NDJSON: exactly one JSON object per line, at most 1 MiB including LF.
- Every message carries `protocol`, `version`, `type`, and a bounded correlation `id`. Unknown top-level
  fields and unsupported versions fail before call payload dispatch.
- A host may return a version-mismatch diagnostic using its own supported version when it can safely recover
  the request id, but must not dispatch an unsupported request. Version negotiation is not optimistic parsing.
- Breaking field or semantic changes require a new major version. A new optional feature still requires an
  advertised namespaced method; receivers never infer support from a higher minor version.

Windows NDJSON `0.2` is source material, not an alias or compatibility version of this protocol. Its UIA
locator, action, feature, and error shapes are intentionally absent. A later Windows adapter must explicitly
map `0.2` or migrate the host to `surfaceloom.native/1.0`; it must not relabel `0.2` frames as `1.0`.

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
