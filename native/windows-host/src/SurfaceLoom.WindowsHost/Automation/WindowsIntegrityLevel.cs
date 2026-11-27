namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>
/// Mandatory integrity level of a Windows process token, classified from the RID (last
/// sub-authority) of its S-1-16-* label SID. Localized account names are never consulted.
/// </summary>
public enum WindowsIntegrityLevel
{
    /// <summary>The token label could not be read.</summary>
    Unknown,
    /// <summary>A label was read, but its RID is not one of the documented levels.</summary>
    Unrecognized,
    Untrusted,
    Low,
    Medium,
    MediumPlus,
    High,
    System,
    ProtectedProcess,
}

public enum WindowsIntegrityReadFailure
{
    None,
    NotWindows,
    InvalidProcessId,
    OpenProcessFailed,
    OpenTokenFailed,
    QueryTokenFailed,
    MalformedLabel,
}

public sealed record WindowsIntegrityReading(
    WindowsIntegrityLevel Level,
    uint? Rid,
    WindowsIntegrityReadFailure Failure,
    int? Win32Error)
{
    /// <summary>True only when a label RID was actually read from the token.</summary>
    public bool HasRid => Rid is not null && Failure == WindowsIntegrityReadFailure.None;

    public static WindowsIntegrityReading FromRid(uint rid) =>
        new(WindowsIntegrityLevels.Classify(rid), rid, WindowsIntegrityReadFailure.None, null);

    public static WindowsIntegrityReading Failed(
        WindowsIntegrityReadFailure failure,
        int? win32Error = null) =>
        new(WindowsIntegrityLevel.Unknown, null, failure, win32Error);
}

/// <summary>Typed conclusion of comparing the host token with a target process token.</summary>
public enum IntegrityBoundaryVerdict
{
    /// <summary>The target is at or below the host level; integrity does not block UIA.</summary>
    TargetNotHigher,
    /// <summary>The target is above the host level; UIA cannot inspect it from this host.</summary>
    TargetHigher,
    /// <summary>The host level is unknown, so no boundary conclusion is possible.</summary>
    HostUnknown,
    /// <summary>The target level is unknown, so no boundary conclusion is possible.</summary>
    TargetUnknown,
}

public sealed record IntegrityBoundaryEvaluation(
    IntegrityBoundaryVerdict Verdict,
    WindowsIntegrityReading Host,
    WindowsIntegrityReading Target);

public static class WindowsIntegrityLevels
{
    // Documented SECURITY_MANDATORY_*_RID values from winnt.h.
    public const uint UntrustedRid = 0x0000;
    public const uint LowRid = 0x1000;
    public const uint MediumRid = 0x2000;
    public const uint MediumPlusRid = 0x2100;
    public const uint HighRid = 0x3000;
    public const uint SystemRid = 0x4000;
    public const uint ProtectedProcessRid = 0x5000;

    /// <summary>
    /// Maps an exact documented RID to its level. Any other value is reported as
    /// <see cref="WindowsIntegrityLevel.Unrecognized"/> instead of being rounded to a
    /// neighbouring level, so an unexpected label is never presented as a normal one.
    /// </summary>
    public static WindowsIntegrityLevel Classify(uint rid) => rid switch
    {
        UntrustedRid => WindowsIntegrityLevel.Untrusted,
        LowRid => WindowsIntegrityLevel.Low,
        MediumRid => WindowsIntegrityLevel.Medium,
        MediumPlusRid => WindowsIntegrityLevel.MediumPlus,
        HighRid => WindowsIntegrityLevel.High,
        SystemRid => WindowsIntegrityLevel.System,
        ProtectedProcessRid => WindowsIntegrityLevel.ProtectedProcess,
        _ => WindowsIntegrityLevel.Unrecognized,
    };

    /// <summary>
    /// Pure host-versus-target comparison. Windows mandatory integrity control compares the
    /// numeric label RIDs, so the raw RIDs decide the verdict whenever both were read. An
    /// unreadable side always yields an explicit unknown verdict rather than a pass.
    /// </summary>
    public static IntegrityBoundaryEvaluation Evaluate(
        WindowsIntegrityReading host,
        WindowsIntegrityReading target)
    {
        ArgumentNullException.ThrowIfNull(host);
        ArgumentNullException.ThrowIfNull(target);
        IntegrityBoundaryVerdict verdict;
        if (!host.HasRid)
        {
            verdict = IntegrityBoundaryVerdict.HostUnknown;
        }
        else if (!target.HasRid)
        {
            verdict = IntegrityBoundaryVerdict.TargetUnknown;
        }
        else
        {
            verdict = target.Rid!.Value > host.Rid!.Value
                ? IntegrityBoundaryVerdict.TargetHigher
                : IntegrityBoundaryVerdict.TargetNotHigher;
        }
        return new IntegrityBoundaryEvaluation(verdict, host, target);
    }
}
