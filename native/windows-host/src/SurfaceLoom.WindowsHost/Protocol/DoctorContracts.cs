namespace SurfaceLoom.WindowsHost.Protocol;

public enum DoctorStatus
{
    Pass,
    Warn,
    Fail,
    Unsupported,
}

public sealed record DoctorCheck(
    string Id,
    DoctorStatus Status,
    string Summary,
    bool Required,
    object? Details = null,
    string? Remediation = null);

public sealed record HostDoctorReport(
    string SchemaVersion,
    string ProtocolVersion,
    string Platform,
    bool ReadOnly,
    DateTimeOffset GeneratedAt,
    DoctorStatus Overall,
    IReadOnlyList<DoctorCheck> Checks);
