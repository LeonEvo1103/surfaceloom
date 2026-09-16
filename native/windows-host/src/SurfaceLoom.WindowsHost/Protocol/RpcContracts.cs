using System.Text.Json;
using System.Text.Json.Serialization;

namespace SurfaceLoom.WindowsHost.Protocol;

public sealed record RpcRequest
{
    [JsonPropertyName("protocolVersion")]
    public string ProtocolVersion { get; init; } = string.Empty;

    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("method")]
    public string Method { get; init; } = string.Empty;

    [JsonPropertyName("params")]
    public JsonElement Parameters { get; init; }
}

public sealed record RpcError(string Code, string Message, object? Details = null);

public sealed record RpcResponse
{
    public required string ProtocolVersion { get; init; }
    public required string Id { get; init; }
    public required bool Ok { get; init; }
    public object? Result { get; init; }
    public RpcError? Error { get; init; }

    public static RpcResponse Success(string id, object result) => new()
    {
        ProtocolVersion = HostProtocol.Version,
        Id = id,
        Ok = true,
        Result = result,
    };

    public static RpcResponse Failure(string id, RpcError error) => new()
    {
        ProtocolVersion = HostProtocol.Version,
        Id = id,
        Ok = false,
        Error = error,
    };
}

public sealed record HandshakeResult(
    string ProtocolVersion,
    string HostName,
    string Platform,
    int ProcessId,
    IReadOnlyList<string> Methods);
