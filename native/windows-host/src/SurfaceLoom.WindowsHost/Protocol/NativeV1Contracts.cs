using System.Text.Json;
using System.Text.Json.Serialization;

namespace SurfaceLoom.WindowsHost.Protocol;

public static class NativeV1Protocol
{
    public const string Name = "surfaceloom.native";
    public const string Version = "1.0";
    public const int MaxMessageBytes = 1_048_576;
    public const int MaxDeadlineMs = 120_000;

    public static IReadOnlyDictionary<string, NativeV1MethodDescriptor> Methods { get; } =
        new Dictionary<string, NativeV1MethodDescriptor>(StringComparer.Ordinal)
        {
            [HostProtocol.Handshake] = new(HostProtocol.Handshake, "observe", ["bootstrap"]),
            [HostProtocol.RunDoctor] = new(HostProtocol.RunDoctor, "observe", ["host"]),
            [HostProtocol.GetCapabilities] = new(HostProtocol.GetCapabilities, "observe", ["host"]),
            [HostProtocol.LaunchSession] = new(HostProtocol.LaunchSession, "lifecycle", ["host"]),
            [HostProtocol.AttachSession] = new(HostProtocol.AttachSession, "lifecycle", ["host"]),
            [HostProtocol.OpenDesktopSession] = new(HostProtocol.OpenDesktopSession, "lifecycle", ["host"]),
            [HostProtocol.ReleaseSession] = new(HostProtocol.ReleaseSession, "lifecycle", ["session"]),
            [HostProtocol.CloseSession] = new(HostProtocol.CloseSession, "lifecycle", ["session"]),
            [HostProtocol.TerminateSession] = new(HostProtocol.TerminateSession, "lifecycle", ["session"]),
            [HostProtocol.FindElement] = new(HostProtocol.FindElement, "observe", ["session", "handle"]),
            [HostProtocol.FindElements] = new(HostProtocol.FindElements, "observe", ["session", "handle"]),
            [HostProtocol.QueryElementBatch] = new(HostProtocol.QueryElementBatch, "observe", ["session", "handle"]),
            [HostProtocol.GetElement] = new(HostProtocol.GetElement, "observe", ["handle"]),
            [HostProtocol.PerformAction] = new(HostProtocol.PerformAction, "mutate", ["handle"]),
        };
}

public sealed record NativeV1MethodDescriptor(
    string Name,
    string Intent,
    IReadOnlyList<string> ScopeKinds);

public sealed record NativeV1Scope(
    string Kind,
    string? HostInstanceId,
    string? SessionId,
    string? HandleId);

public sealed record NativeV1Call(
    string Name,
    string Intent,
    NativeV1Scope Scope,
    JsonElement Payload,
    string? OperationId);

public sealed record NativeV1Request(
    string Id,
    int TimeoutMs,
    NativeV1Call Call);

public sealed record NativeV1Cancel(
    string Id,
    string RequestId,
    string Reason);

public sealed record NativeV1OperationReceipt(
    string OperationId,
    string Outcome);

public sealed record NativeV1Error(
    string Code,
    string Category,
    string Message,
    string Retry,
    object? Details = null);

public sealed record NativeV1Response
{
    [JsonPropertyName("protocol")]
    public string Protocol { get; init; } = NativeV1Protocol.Name;

    [JsonPropertyName("version")]
    public string Version { get; init; } = NativeV1Protocol.Version;

    [JsonPropertyName("type")]
    public string Type { get; init; } = "response";

    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("ok")]
    public required bool Ok { get; init; }

    [JsonPropertyName("result")]
    public object? Result { get; init; }

    [JsonPropertyName("error")]
    public NativeV1Error? Error { get; init; }

    [JsonPropertyName("operation")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public NativeV1OperationReceipt? Operation { get; init; }
}

public sealed record NativeV1HostDescriptor(
    string HostInstanceId,
    string Platform,
    string Backend,
    IReadOnlyList<NativeV1MethodDescriptor> Methods,
    int MaxMessageBytes);

public sealed record NativeV1Handle(
    string HostInstanceId,
    string SessionId,
    string HandleId);

public sealed record NativeV1SessionDescriptor(
    string HostInstanceId,
    string SessionId,
    string Ownership,
    string Surface,
    NativeV1Handle Root);

public sealed record NativeV1ElementResult(
    NativeV1Handle Handle,
    ElementSnapshot Snapshot);

public sealed record NativeV1BatchClauseResult(
    int ClauseIndex,
    IReadOnlyList<NativeV1ElementResult> Elements);

public sealed record NativeV1BatchResult(
    IReadOnlyList<NativeV1BatchClauseResult> Clauses);
