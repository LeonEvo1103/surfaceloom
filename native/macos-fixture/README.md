# SurfaceLoom macOS fixture

This directory contains a product-neutral AppKit application for exercising native macOS accessibility automation. Its machine-readable contract deliberately matches the Windows fixture's invoke, value/mirror, strict ambiguity, transient removal/restoration, and owned-close behaviors.

## Build and verify

```sh
./scripts/verify.sh
```

The verification command runs the dependency-free portable state-model test executable, static source checks, cross-platform contract-parity checks, and a release build. It does not launch the GUI or request Accessibility consent.

To launch the fixture manually:

```sh
swift run --package-path native/macos-fixture SurfaceLoomMacOSFixture
```

The app itself never asks for or changes Accessibility/TCC permissions. A live conformance harness must run the automation client under user-controlled Accessibility authorization.

## Stable surface

`fixture-contract.v1.json` is the normative behavior contract. All actionable controls use stable `surfaceloom.fixture.*` AX identifiers. The two ambiguous buttons intentionally share the same accessible name while retaining distinct identifiers. Invoking the transient button removes it from the actual AppKit view hierarchy; invoking restore inserts the same control back into the hierarchy.

Closing the owned fixture window transitions its model to `closing` and terminates the application after the last window closes.
