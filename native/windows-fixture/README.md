# SurfaceLoom Windows UIA Fixture

This directory contains a product-neutral, deterministic WPF application for SurfaceLoom native
conformance. It is a test target, not a native host and not an application adapter. It never opens a
network connection, requests elevation, reads user data, or talks to a company service.

The fixture exposes stable UI Automation identities for five contracts:

1. `InvokePattern` increments an observable counter exactly once per invocation.
2. `ValuePattern.SetValue` updates an independent, read-only mirror.
3. a deliberately broad name locator matches exactly two buttons, so strict clients must report
   ambiguity rather than select by tree order.
4. invoking a transient button removes that same button from the UIA tree; a separate reset control
   restores the deterministic baseline.
5. an owned process has a stable main window and a close control that requests normal application
   shutdown. Conformance must additionally observe process exit; a UI label alone is not proof.

The normative identities, initial state, transitions, and live assertions are in
[`fixture-contract.v1.json`](./fixture-contract.v1.json). See [`CONFORMANCE.md`](./CONFORMANCE.md) for
the distinction between portable checks and Windows live evidence.

## Portable checks

These checks require Node.js but do not claim that WPF or UIA ran:

```sh
node --test tests/contract-model.test.mjs tests/static-contract.test.mjs
```

They validate the machine-readable behavior model, XAML identities, event wiring, product neutrality,
and the absence of network/elevation/package dependencies.

## Windows build and model checks

Use Windows 10 2004 or later with the .NET 8 SDK in an interactive user session:

```powershell
.\scripts\verify.ps1
dotnet run --project .\src\SurfaceLoom.WindowsFixture -c Release
.\scripts\live-conformance.ps1
```

`verify.ps1` runs the portable contract checks, builds the WPF application, and executes the .NET
state-model test executable. It still does not count as live UIA conformance.

`live-conformance.ps1` builds the adjacent Windows host and this fixture, then launches the real WPF
process through the versioned NDJSON host. It executes all five required cases with zero skip support
under the shared Windows user/session/default-desktop GUI execution gate. Before using any generated
JavaScript it installs and builds Core, Reporter, and Test in dependency order, then runs the
interactive-session storage/process/gate contracts. It writes `artifacts/windows-live-conformance.json`
only after fixture and host cleanup is confirmed, and writes runner-local
`artifacts/sl-p2-080-windows-evidence.json` only after the gate is released and a successor proves entry.
The trusted PowerShell wrapper reads the SID, process session, and desktop from Windows; the public
gate acquisition API validates their shape and lock-domain normalization but does not independently
attest that caller-supplied identity facts came from the current token.
Run it only in an interactive Windows session;
a cross-compiled binary, model test, or headless job is not equivalent evidence.

The required file-symlink tests never skip. If the account cannot create file symbolic links, the run
fails with diagnostics; the script does not change UAC, Developer Mode, or system policy. This entry
does not implement the planned real Node-to-UIA Case path or business mixed-surface Case.

For release evidence, pass immutable revisions instead of the default `working-tree` labels:

```powershell
.\scripts\live-conformance.ps1 -HostRevision <commit> -FixtureRevision <commit>
```
