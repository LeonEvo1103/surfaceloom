using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public static class WindowsHostDoctor
{
    public const string SchemaVersion = "1";
    public const int MinimumWindowsBuild = 19041;

    public const string OsCheck = "windows.os";
    public const string SessionCheck = "windows.session";
    public const string InteractiveDesktopCheck = "windows.interactiveDesktop";
    public const string UiaCheck = "windows.uia.root";
    public const string IntegrityBoundaryCheck = "windows.integrityBoundary";
    public const string PointerInjectionCheck = "input.pointerInjection";
    public const string KeyboardInjectionCheck = "input.keyboardInjection";
    public const string SecureDesktopCheck = "windows.uac.secureDesktop";

    public static HostDoctorReport Run()
    {
        var checks = new List<DoctorCheck>
        {
            CheckOperatingSystem(),
            CheckUserSession(),
            CheckInteractiveDesktop(),
            CheckUiaRoot(),
            DescribeIntegrityBoundary(),
            UnsupportedPointerInjection(),
            UnsupportedKeyboardInjection(),
            UnsupportedSecureDesktop(),
        };

        return new HostDoctorReport(
            SchemaVersion,
            HostProtocol.Version,
            "windows",
            true,
            DateTimeOffset.UtcNow,
            CalculateOverall(checks),
            checks);
    }

    private static DoctorCheck CheckOperatingSystem()
    {
        var version = Environment.OSVersion.Version;
        var supported = OperatingSystem.IsWindows() &&
            (version.Major > 10 ||
             version.Major == 10 && version.Build >= MinimumWindowsBuild);

        return new DoctorCheck(
            OsCheck,
            supported ? DoctorStatus.Pass : DoctorStatus.Fail,
            supported
                ? "Windows version meets the host minimum."
                : $"Windows 10 build {MinimumWindowsBuild} or newer is required.",
            true,
            new
            {
                description = RuntimeInformation.OSDescription,
                version = version.ToString(),
                build = version.Build,
                minimumBuild = MinimumWindowsBuild,
                processArchitecture = RuntimeInformation.ProcessArchitecture.ToString(),
                osArchitecture = RuntimeInformation.OSArchitecture.ToString(),
            },
            supported ? null : "Upgrade the Windows test VM or runner before starting UI sessions.");
    }

    private static DoctorCheck CheckUserSession()
    {
        try
        {
            using var process = Process.GetCurrentProcess();
            var sessionId = process.SessionId;
            var supported = sessionId != 0;
            return new DoctorCheck(
                SessionCheck,
                supported ? DoctorStatus.Pass : DoctorStatus.Fail,
                supported
                    ? "Host is running in a logged-on user session."
                    : "Session 0 and Windows Service contexts cannot drive this UIA host.",
                true,
                new { sessionId, processId = Environment.ProcessId },
                supported
                    ? null
                    : "Run the host from an interactive user logon in an isolated Windows VM.");
        }
        catch (Exception exception)
        {
            return FailedCheck(
                SessionCheck,
                "The host could not determine its Windows user session.",
                exception,
                "Run the host directly from a logged-on user session.");
        }
    }

    private static DoctorCheck CheckInteractiveDesktop()
    {
        if (!Environment.UserInteractive)
        {
            return new DoctorCheck(
                InteractiveDesktopCheck,
                DoctorStatus.Fail,
                "The process is not attached to an interactive user desktop.",
                true,
                new { environmentUserInteractive = false },
                "Do not run desktop UI tests from a Windows Service or Session 0.");
        }

        try
        {
            var inspection = InputDesktopInspector.Inspect();
            if (!inspection.Accessible)
            {
                return new DoctorCheck(
                    InteractiveDesktopCheck,
                    DoctorStatus.Fail,
                    "The current input desktop could not be opened for read-only inspection.",
                    true,
                    new
                    {
                        environmentUserInteractive = true,
                        inspection.Win32Error,
                        inspection.ErrorMessage,
                    },
                    "Unlock the user session and make sure the default desktop is active.");
            }

            var isDefault = string.Equals(
                inspection.Name,
                "Default",
                StringComparison.OrdinalIgnoreCase);
            return new DoctorCheck(
                InteractiveDesktopCheck,
                isDefault ? DoctorStatus.Pass : DoctorStatus.Fail,
                isDefault
                    ? "The default interactive input desktop is active and readable."
                    : "A non-default input desktop is active; the host will not switch desktops.",
                true,
                new
                {
                    environmentUserInteractive = true,
                    inputDesktop = inspection.Name,
                    inspectionMode = "readOnly",
                },
                isDefault ? null : "Return to the unlocked default desktop before running UI tests.");
        }
        catch (Exception exception)
        {
            return FailedCheck(
                InteractiveDesktopCheck,
                "Interactive desktop inspection failed.",
                exception,
                "Run the host on supported Windows in an unlocked user session.");
        }
    }

    private static DoctorCheck CheckUiaRoot()
    {
        try
        {
            var root = AutomationElement.RootElement;
            var current = root.Current;
            return new DoctorCheck(
                UiaCheck,
                DoctorStatus.Pass,
                "Windows UI Automation exposed a readable desktop root element.",
                true,
                new
                {
                    name = current.Name ?? string.Empty,
                    controlType = UiaControlTypeMap.GetName(current.ControlType),
                    nativeWindowHandle = current.NativeWindowHandle,
                });
        }
        catch (Exception exception)
        {
            return FailedCheck(
                UiaCheck,
                "Windows UI Automation root access failed.",
                exception,
                "Verify the user desktop is unlocked and the UIA service is available.");
        }
    }

    private static DoctorCheck DescribeIntegrityBoundary() => new(
        IntegrityBoundaryCheck,
        DoctorStatus.Warn,
        "Doctor does not probe a target process; UIA access remains subject to Windows integrity " +
        "and UIAccess boundaries.",
        false,
        new { targetProbed = false, bypassAttempted = false },
        "Run the host at an integrity level permitted to inspect the intended target application.");

    private static DoctorCheck UnsupportedPointerInjection() => new(
        PointerInjectionCheck,
        DoctorStatus.Unsupported,
        "This host has no synthetic pointer or coordinate-click backend.",
        false,
        new { implemented = false, coordinateFallback = false });

    private static DoctorCheck UnsupportedKeyboardInjection() => new(
        KeyboardInjectionCheck,
        DoctorStatus.Unsupported,
        "This host has no synthetic keyboard input backend.",
        false,
        new { implemented = false, implicitFallback = false });

    private static DoctorCheck UnsupportedSecureDesktop() => new(
        SecureDesktopCheck,
        DoctorStatus.Unsupported,
        "UAC Secure Desktop is a security boundary and is not automated, switched to, bypassed, or auto-approved.",
        false,
        new { attempted = false, bypassAttempted = false },
        "Validate the Secure Desktop portion manually or in a dedicated recoverable system-level test environment.");

    private static DoctorCheck FailedCheck(
        string id,
        string summary,
        Exception exception,
        string remediation) => new(
            id,
            DoctorStatus.Fail,
            summary,
            true,
            new { exception = exception.GetType().Name, message = exception.Message },
            remediation);

    private static DoctorStatus CalculateOverall(IEnumerable<DoctorCheck> checks)
    {
        var all = checks.ToArray();
        if (all.Any(check => check.Required && check.Status == DoctorStatus.Fail))
        {
            return DoctorStatus.Fail;
        }
        if (all.Any(check => check.Required && check.Status == DoctorStatus.Unsupported))
        {
            return DoctorStatus.Unsupported;
        }

        return all.Any(check => check.Status is DoctorStatus.Warn or DoctorStatus.Fail)
            ? DoctorStatus.Warn
            : DoctorStatus.Pass;
    }
}
