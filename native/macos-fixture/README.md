# SurfaceLoom macOS fixture

This directory contains a product-neutral AppKit application for exercising native macOS accessibility automation. Its machine-readable contract deliberately matches the Windows fixture's invoke, value/mirror, strict ambiguity, transient removal/restoration, and owned-close behaviors.

## Build and verify

```sh
./scripts/verify.sh
```

The verification command runs the dependency-free portable state-model test executable, creates a release
`.app` bundle, and runs static source, bundle, and cross-platform contract-parity checks. It does not launch
the GUI or request Accessibility consent. The ignored build artifact is written to:

```text
build/artifacts/SurfaceLoomMacOSFixture.app
```

The bundle has the stable identifier `dev.surfaceloom.fixture.macos`, executable
`SurfaceLoomMacOSFixture`, and minimum OS `13.0`. `scripts/build-app.sh` can be run independently; its
`SURFACELOOM_FIXTURE_ARTIFACT_ROOT` environment variable selects a different output root without changing
the bundle identity.

To launch the SwiftPM executable manually:

```sh
swift run --package-path native/macos-fixture SurfaceLoomMacOSFixture
```

The app itself never asks for or changes Accessibility/TCC permissions. A live conformance harness must run the automation client under user-controlled Accessibility authorization.

The generated bundle has no Developer ID/distribution signature and its resources are not sealed. The Swift
linker may apply an ad-hoc signature to the executable, which is not a stable release or TCC identity. Bundle
signing, hardened-runtime/notarization policy, TCC preflight, and live AX conformance belong to later
host/release tasks; a successful artifact build is not evidence for any of them.

## Stable surface

`fixture-contract.v1.json` is the normative behavior contract. All actionable controls use stable `surfaceloom.fixture.*` AX identifiers. The two ambiguous buttons intentionally share the same accessible name while retaining distinct identifiers. Invoking the transient button removes it from the actual AppKit view hierarchy; invoking restore inserts the same control back into the hierarchy.

Closing the owned fixture window transitions its model to `closing` and terminates the application after the last window closes.
