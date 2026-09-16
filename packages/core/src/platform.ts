export const desktopPlatforms = ["macos", "windows"] as const;

export type DesktopPlatform = (typeof desktopPlatforms)[number];

export const webPlatforms = ["web"] as const;

export type WebPlatform = (typeof webPlatforms)[number];

/** Every platform dimension a case may declare an executable implementation for. */
export const testPlatforms = [...desktopPlatforms, ...webPlatforms] as const;

export type TestPlatform = (typeof testPlatforms)[number];

export interface BaseAppTarget {
  /** Stable project-owned identifier, independent of an OS package identifier. */
  readonly id: string;
  readonly displayName: string;
  readonly launchArguments?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export type MacOSLaunchIdentity =
  | { readonly bundleId: string; readonly appPath?: string }
  | { readonly bundleId?: string; readonly appPath: string };

export type WindowsLaunchIdentity =
  | { readonly executablePath: string; readonly appUserModelId?: string }
  | { readonly executablePath?: string; readonly appUserModelId: string };

export type MacOSAppTarget = BaseAppTarget &
  MacOSLaunchIdentity & {
    readonly platform: "macos";
  };

export type WindowsAppTarget = BaseAppTarget &
  WindowsLaunchIdentity & {
    readonly platform: "windows";
    readonly processName?: string;
    readonly workingDirectory?: string;
  };

export type AppTarget = MacOSAppTarget | WindowsAppTarget;

export type AppTargetFor<P extends DesktopPlatform> = Extract<
  AppTarget,
  { readonly platform: P }
>;

export function isAppTarget(value: unknown): value is AppTarget {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const target = value as Record<string, unknown>;
  if (
    typeof target.id !== "string" ||
    target.id.length === 0 ||
    typeof target.displayName !== "string" ||
    target.displayName.length === 0
  ) {
    return false;
  }

  if (target.platform === "macos") {
    return isNonEmptyString(target.bundleId) || isNonEmptyString(target.appPath);
  }

  if (target.platform === "windows") {
    return (
      isNonEmptyString(target.executablePath) ||
      isNonEmptyString(target.appUserModelId)
    );
  }

  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
