import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicationDesktopSession } from "../../src/desktop-session/index.js";
import type { WindowsCoreSession, WindowsDesktopSession } from "../../src/windows/index.js";
import type { WindowsLaunchOptions } from "../../src/windows/index.js";

type Owned = WindowsDesktopSession<"owned">;
type Borrowed = WindowsDesktopSession<"borrowed">;
type Expected = ApplicationDesktopSession<"windows", WindowsCoreSession>;

const ownedAssignable: Owned extends Expected ? true : false = true;
const borrowedAssignable: Borrowed extends Expected ? true : false = true;

if (false) {
  const borrowed = null as unknown as Borrowed;
  // @ts-expect-error Borrowed sessions do not expose destructive lifecycle authority.
  void borrowed.lifecyclePort;
  const owned = null as unknown as Owned;
  void owned.lifecyclePort.terminate;
  // @ts-expect-error v1 launch cannot produce a trustworthy UIA root without waiting for a window.
  const unsupported: WindowsLaunchOptions = { executablePath: "C:\\fixture.exe", waitForWindow: false };
  void unsupported;
}

test("public Windows session types conform to the shared application desktop contract", () => {
  assert.equal(ownedAssignable, true);
  assert.equal(borrowedAssignable, true);
});
