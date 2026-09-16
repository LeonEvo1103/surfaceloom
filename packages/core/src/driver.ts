import type { DesktopCapability } from "./capabilities.js";
import type { DoctorReport } from "./doctor.js";
import type { GuardedElementActions } from "./guarded-actions.js";
import type { Locator } from "./locator.js";
import type {
  AppTargetFor,
  DesktopPlatform,
} from "./platform.js";

export type ProfileIsolation =
  | { readonly kind: "ephemeral" }
  | { readonly kind: "isolated"; readonly directory: string }
  | { readonly kind: "existing"; readonly directory?: string };

export interface LaunchOptions {
  readonly resetState?: boolean;
  readonly timeoutMs?: number;
  /** Additional launch environment supplied by an app adapter. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Declares state ownership; the native driver decides how it maps to launch flags. */
  readonly profileIsolation?: ProfileIsolation;
}

export interface AttachOptions {
  readonly timeoutMs?: number;
  readonly rejectAmbiguousMatch?: boolean;
}

export interface FindOptions {
  readonly timeoutMs?: number;
  readonly requireVisible?: boolean;
}

export interface OperationOptions {
  readonly timeoutMs?: number;
}

export interface ElementReference {
  readonly id: string;
  readonly locator: Locator;
  readonly role?: string;
  readonly name?: string;
}

export interface WindowInfo {
  readonly id: string;
  readonly title?: string;
  readonly active: boolean;
  readonly minimized: boolean;
}

export type WindowCommand =
  | "focus"
  | "close"
  | "minimize"
  | "restore"
  | "maximize";

export type WaitCondition =
  | { readonly kind: "exists" }
  | { readonly kind: "notExists" }
  | { readonly kind: "visible" }
  | { readonly kind: "enabled" }
  | { readonly kind: "valueEquals"; readonly value: string };

export type KeyModifier =
  | "primary"
  | "meta"
  | "control"
  | "alt"
  | "shift"
  | "function";

export interface KeyChord {
  readonly key: string;
  readonly modifiers?: readonly KeyModifier[];
}

export interface ScreenshotResult {
  readonly format: "png";
  readonly path?: string;
  readonly base64?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface SessionDiagnostics {
  readonly sessionId: string;
  readonly platform: DesktopPlatform;
  readonly processId?: number;
  readonly activeWindow?: WindowInfo;
  readonly accessibilityTreePath?: string;
  readonly screenshotPath?: string;
  readonly messages: readonly string[];
}

export interface AppSession<P extends DesktopPlatform = DesktopPlatform> {
  readonly id: string;
  readonly platform: P;
  readonly target: AppTargetFor<P>;
  readonly capabilities: readonly DesktopCapability[];
  /** Guarded action facade. Raw native actions are not exposed to components. */
  readonly actions: GuardedElementActions;

  find(locator: Locator, options?: FindOptions): Promise<ElementReference>;
  /** Returns every candidate and does not apply the locator's singular match policy. */
  findAll(locator: Locator, options?: FindOptions): Promise<readonly ElementReference[]>;
  waitFor(
    locator: Locator,
    condition: WaitCondition,
    options?: FindOptions,
  ): Promise<ElementReference | undefined>;
  pressShortcut(chord: KeyChord, options?: OperationOptions): Promise<void>;
  windows(): Promise<readonly WindowInfo[]>;
  manageWindow(
    windowId: string,
    command: WindowCommand,
    options?: OperationOptions,
  ): Promise<void>;
  screenshot(name?: string): Promise<ScreenshotResult>;
  diagnostics(): Promise<SessionDiagnostics>;
  detach(): Promise<void>;
  quit(): Promise<void>;
  terminate(): Promise<void>;
}

export interface DesktopDriver<P extends DesktopPlatform = DesktopPlatform> {
  readonly platform: P;
  readonly capabilities: readonly DesktopCapability[];

  doctor(target: AppTargetFor<P>): Promise<DoctorReport<P>>;
  launch(target: AppTargetFor<P>, options?: LaunchOptions): Promise<AppSession<P>>;
  attach(target: AppTargetFor<P>, options?: AttachOptions): Promise<AppSession<P>>;
}
