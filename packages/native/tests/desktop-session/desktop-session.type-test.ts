import type { AppSession } from "../../../core/src/driver.js";
import type {
  ApplicationDesktopSession,
  NativeLocatorFor,
  SystemDesktopSession,
} from "../../src/desktop-session/contracts.js";

type Application = ApplicationDesktopSession<"macos", AppSession<"macos">>;
type OwnedApplication = Extract<Application, { readonly ownership: "owned" }>;
declare const owned: OwnedApplication;
const core: AppSession<"macos"> = owned;
void core;
owned.quit();
owned.terminate();

// @ts-expect-error AX sessions cannot accept a UIA locator.
const wrongMacLocator: NativeLocatorFor<"macos"> = { backend: "uia", automationId: "save" };
void wrongMacLocator;

type SystemHasNoTarget = "target" extends keyof SystemDesktopSession<"macos"> ? false : true;
const systemHasNoTarget: SystemHasNoTarget = true;
void systemHasNoTarget;

type BorrowedApplication = Extract<Application, { readonly ownership: "borrowed" }>;
type BorrowedHasNoTerminate = "lifecyclePort" extends keyof BorrowedApplication ? false : true;
const borrowedHasNoTerminate: BorrowedHasNoTerminate = true;
void borrowedHasNoTerminate;
declare const borrowed: BorrowedApplication;
borrowed.detach();
// @ts-expect-error borrowed application sessions do not expose graceful app exit.
borrowed.quit();
// @ts-expect-error borrowed application sessions do not expose forced app termination.
borrowed.terminate();
