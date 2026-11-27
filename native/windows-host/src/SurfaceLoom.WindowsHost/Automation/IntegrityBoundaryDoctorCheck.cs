using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>
/// Maps a host-token integrity reading to the <c>windows.integrityBoundary</c> doctor check.
/// The check stays non-required because doctor never probes a target: whether a given level
/// blocks depends on the application under test, and a non-required fail still makes the
/// overall verdict at least <c>warn</c> without blocking an elevated CI runner.
/// </summary>
internal static class IntegrityBoundaryDoctorCheck
{
    private const string NonElevatedRemediation =
        "Re-run the host from a non-elevated terminal in the logged-on user's normal session. " +
        "Only run it elevated when the target application itself must run elevated.";

    public static DoctorCheck Create(WindowsIntegrityReading host)
    {
        ArgumentNullException.ThrowIfNull(host);
        var (status, summary, remediation) = Describe(host);
        return new DoctorCheck(
            WindowsHostDoctor.IntegrityBoundaryCheck,
            status,
            summary,
            false,
            new
            {
                hostProbed = true,
                hostIntegrityLevel = host.Level,
                hostIntegrityRid = host.Rid,
                hostReadFailure = host.Failure == WindowsIntegrityReadFailure.None
                    ? (WindowsIntegrityReadFailure?)null
                    : host.Failure,
                hostWin32Error = host.Win32Error,
                canInspectElevatedTargets = host.HasRid
                    ? host.Rid!.Value >= WindowsIntegrityLevels.HighRid
                    : (bool?)null,
                targetProbed = false,
                bypassAttempted = false,
            },
            remediation);
    }

    private static (DoctorStatus Status, string Summary, string? Remediation) Describe(
        WindowsIntegrityReading host) => host.Level switch
    {
        WindowsIntegrityLevel.Medium or WindowsIntegrityLevel.MediumPlus => (
            DoctorStatus.Pass,
            "Host runs at standard user integrity; it can inspect ordinary applications but not " +
            "elevated (High) targets. No target process was probed.",
            null),
        WindowsIntegrityLevel.High => (
            DoctorStatus.Warn,
            "Host runs elevated (High integrity). It can inspect elevated targets, but tests run " +
            "with administrator rights and will not see the integrity boundary real users hit.",
            NonElevatedRemediation),
        WindowsIntegrityLevel.Untrusted or WindowsIntegrityLevel.Low => (
            DoctorStatus.Fail,
            "Host runs below standard user integrity; UI Automation cannot inspect ordinary " +
            "Medium-integrity applications from this host.",
            "Run the host from a normal, non-sandboxed user terminal rather than a Low-integrity " +
            "or sandboxed parent process."),
        WindowsIntegrityLevel.System or WindowsIntegrityLevel.ProtectedProcess => (
            DoctorStatus.Fail,
            "Host runs at System or protected-process integrity, which is not a supported or " +
            "least-privilege configuration for desktop UI tests.",
            "Run the host as the logged-on interactive user from a non-elevated terminal, not as " +
            "SYSTEM or a service."),
        WindowsIntegrityLevel.Unrecognized => (
            DoctorStatus.Warn,
            "Host token carries an integrity label RID that is not a documented level; its UIA " +
            "boundary cannot be classified.",
            NonElevatedRemediation),
        _ => (
            DoctorStatus.Warn,
            "Host integrity level could not be read; the UIA integrity boundary is unverified and " +
            "must not be assumed to be normal.",
            "Check hostReadFailure and hostWin32Error, then re-run the host from a non-elevated " +
            "terminal in the logged-on user's normal session."),
    };
}
