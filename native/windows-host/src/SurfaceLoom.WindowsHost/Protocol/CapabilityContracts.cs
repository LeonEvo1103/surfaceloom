namespace SurfaceLoom.WindowsHost.Protocol;

public enum SupportLevel
{
    Supported,
    Conditional,
    Unsupported,
}

public sealed record CapabilityStatus(
    SupportLevel Support,
    string Summary,
    IReadOnlyList<string>? Conditions = null);

public sealed record HostCapabilities(
    string ProtocolVersion,
    string Platform,
    string Backend,
    IReadOnlyList<string> Methods,
    IReadOnlyList<string> LocatorFields,
    IReadOnlyList<string> ControlTypes,
    IReadOnlyDictionary<UiaAction, string> ActionRequirements,
    IReadOnlyDictionary<string, CapabilityStatus> Features);
