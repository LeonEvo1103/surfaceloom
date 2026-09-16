# `@surfaceloom/core`

Platform-neutral contracts for desktop UI automation. The package deliberately
does not import XCTest, Accessibility, UI Automation, Appium, or a product SDK.
Native executors implement `DesktopDriver` and return an `AppSession`.

Core also provides the execution primitives shared by runners:

- an execution-independent `CaseSpec` with stable ids, canonical locale,
  an explicit non-empty `macos`/`windows`/`web` platform set, original intent,
  preconditions, acceptance criteria, and side-effect policy;
- strict-by-default semantic locators;
- a guarded action facade which checks actionability before submitting a side
  effect exactly once;
- on-demand test/worker fixtures with reverse-order teardown;
- a fixture registry connecting manifest ids to executable product setup;
- read-only doctor reports;
- ordered trace events with sensitive-key redaction.

`defineCaseSpec()` validates and deeply freezes the authoring contract, including
the platform list. For
`locale: "zh-CN"`, canonical suite/name/intent/clause text must contain Chinese;
execution status, timing, steps, and evidence belong to the runner result and
must not be written into the spec.

`DesktopPlatform` and `DesktopDriver` remain native-only. Web cases use the
broader `TestPlatform` dimension and the curated `webCapabilities` registry, so
adding browser runs does not weaken native driver typing.

```ts
import {
  summarizeDoctor,
  type DesktopDriver,
  type WindowsAppTarget,
} from "@surfaceloom/core";

const target: WindowsAppTarget = {
  id: "sample.notes",
  displayName: "Sample Notes",
  platform: "windows",
  executablePath: "C:\\Apps\\SampleNotes.exe",
};

async function smoke(driver: DesktopDriver<"windows">) {
  const preflight = await driver.doctor(target);
  if (!summarizeDoctor(preflight).canStartSession) {
    throw new Error("Desktop automation prerequisites are not ready");
  }
  const session = await driver.launch(target);
  await session.manageWindow((await session.windows())[0]!.id, "close");
}
```

Element actions go through `session.actions`, whose concrete type is the
Core-created `GuardedElementActions`. Native adapters declare supported checks
and implement the separate `ElementActionBackend` boundary:
`resolveActionability()` may poll or retry, while `performResolvedAction()` is
called once only after the checks pass. An unsupported required check fails
closed, and Core enforces the resolution timeout even if an adapter ignores the
hint. Semantic components never receive that raw backend.

The backend owns resolved element ids and must reject stale or cross-session
references. Core prevents a timed-out resolution from reaching the raw action,
but does not yet cancel the resolver itself. Concurrent action ordering is not
implicit; scenarios must `await` dependent actions, and platform runners may
serialize a session where the native API requires it.

`Locator` values contain semantic roles, names, identifiers, scopes, and an
explicit match policy. A missing match policy means `strict`: zero matches are
missing and multiple matches are ambiguous. Native
adapters translate them to AX attributes on macOS or UI Automation properties on
Windows. Product-specific fallback selectors belong in an app adapter, not here.

NDJSON/JSON sidecars must pass their result through `parseDoctorReport()` with
the backend's expected check ids before calling `summarizeDoctor()`. Unknown or
missing statuses are rejected instead of being treated as a healthy environment.
