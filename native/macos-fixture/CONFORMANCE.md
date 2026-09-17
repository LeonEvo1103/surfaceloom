# macOS fixture conformance boundary

The checked-in evidence proves that the AppKit fixture builds, its portable state model follows the normative transitions, and its machine contract remains behaviorally aligned with the Windows fixture.

It does not prove live AX discovery or action execution. Live evidence still requires a macOS automation client with explicit user-granted Accessibility permission to launch the built executable and verify:

1. exact identifier lookup and invoke count mutation;
2. AX value setting and mirror propagation;
3. strict-name ambiguity without side effects;
4. disappearance from and restoration to the AX tree;
5. owned window close followed by process exit.

No source or verification script requests, mutates, or bypasses TCC authorization.
