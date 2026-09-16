using System.Text.Json;
using System.Text.Json.Serialization;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Host;

internal static class NativeV1PayloadAdapter
{
    private static readonly JsonSerializerOptions StrictOptions = CreateStrictOptions();

    public static RpcRequest BuildLegacyRequest(NativeV1Request request, int remainingMs)
    {
        var scope = request.Call.Scope;
        var payload = request.Call.Name switch
        {
            HostProtocol.Handshake => Handshake(request.Call.Payload),
            HostProtocol.RunDoctor => Empty(request.Call.Payload),
            HostProtocol.GetCapabilities => Empty(request.Call.Payload),
            HostProtocol.LaunchSession => Launch(request.Call.Payload, remainingMs),
            HostProtocol.AttachSession => Attach(request.Call.Payload, remainingMs),
            HostProtocol.OpenDesktopSession => Desktop(request.Call.Payload),
            HostProtocol.ReleaseSession => EmptyLifecycle(request.Call.Payload, scope.SessionId!),
            HostProtocol.CloseSession => End(request.Call.Payload, scope.SessionId!, remainingMs),
            HostProtocol.TerminateSession => End(request.Call.Payload, scope.SessionId!, remainingMs),
            HostProtocol.FindElement or HostProtocol.FindElements =>
                Find(request.Call.Payload, scope.SessionId!, scope.Kind == "handle" ? scope.HandleId : null, remainingMs),
            HostProtocol.QueryElementBatch =>
                Batch(request.Call.Payload, scope.SessionId!, scope.Kind == "handle" ? scope.HandleId : null),
            HostProtocol.GetElement => EmptyElement(request.Call.Payload, scope.SessionId!, scope.HandleId!),
            HostProtocol.PerformAction => Action(request.Call.Payload, scope.SessionId!, scope.HandleId!),
            _ => throw new HostOperationException("method_not_found", "The native method is not advertised."),
        };
        return new RpcRequest
        {
            ProtocolVersion = HostProtocol.Version,
            Id = request.Id,
            Method = request.Call.Name,
            Parameters = JsonSerializer.SerializeToElement(payload, JsonDefaults.Options),
        };
    }

    private static object Empty(JsonElement payload)
    {
        Deserialize<EmptyPayload>(payload);
        return new { };
    }

    private static object Handshake(JsonElement payload)
    {
        var value = Deserialize<HandshakePayload>(payload);
        if (value.SupportedVersions is not null &&
            !value.SupportedVersions.Contains(NativeV1Protocol.Version, StringComparer.Ordinal))
        {
            throw new HostOperationException("protocol_version_mismatch", "The client does not advertise version 1.0.");
        }
        return new { };
    }

    private static object Launch(JsonElement payload, int remainingMs)
    {
        var value = Deserialize<LaunchPayload>(payload);
        if (value.Executable is null)
        {
            throw new HostOperationException("invalid_request", "executable must be an object.");
        }
        var request = new LaunchSessionRequest
        {
            ExecutablePath = value.Executable.Path,
            Arguments = value.Executable.Arguments,
            WorkingDirectory = value.WorkingDirectory,
            Environment = value.Environment,
            Desktop = value.Desktop,
            WaitForWindow = value.WaitForWindow,
            Window = value.Window,
            Wait = LimitWait(value.Wait, remainingMs),
        };
        ProtocolValidator.Validate(request);
        return request;
    }

    private static object Attach(JsonElement payload, int remainingMs)
    {
        var value = Deserialize<AttachSessionRequest>(payload);
        value = value with { Wait = LimitWait(value.Wait, remainingMs) };
        ProtocolValidator.Validate(value);
        return value;
    }

    private static object Desktop(JsonElement payload)
    {
        var value = Deserialize<DesktopSessionRequest>(payload);
        return value;
    }

    private static object EmptyLifecycle(JsonElement payload, string sessionId)
    {
        Deserialize<EmptyPayload>(payload);
        return new SessionRequest(sessionId);
    }

    private static object End(JsonElement payload, string sessionId, int remainingMs)
    {
        var value = Deserialize<EndPayload>(payload);
        var request = new ProcessEndRequest
        {
            SessionId = sessionId,
            Wait = LimitWait(value.Wait, remainingMs),
        };
        ProtocolValidator.Validate(request);
        return request;
    }

    private static object Find(JsonElement payload, string sessionId, string? rootHandle, int remainingMs)
    {
        var value = Deserialize<FindPayload>(payload);
        var request = new FindElementRequest
        {
            SessionId = sessionId,
            RootElementId = rootHandle,
            Locator = value.Locator,
            Wait = LimitWait(value.Wait, remainingMs),
        };
        ProtocolValidator.Validate(request);
        return request;
    }

    private static object Batch(JsonElement payload, string sessionId, string? rootHandle)
    {
        var value = Deserialize<BatchPayload>(payload);
        var request = new ElementBatchQueryRequest
        {
            SessionId = sessionId,
            RootElementId = rootHandle,
            Clauses = value.Clauses,
        };
        ProtocolValidator.Validate(request);
        return request;
    }

    private static object EmptyElement(JsonElement payload, string sessionId, string handleId)
    {
        Deserialize<EmptyPayload>(payload);
        var request = new ElementRequest(sessionId, handleId);
        ProtocolValidator.Validate(request);
        return request;
    }

    private static object Action(JsonElement payload, string sessionId, string handleId)
    {
        var value = Deserialize<ActionPayload>(payload);
        var request = new ElementActionRequest
        {
            SessionId = sessionId,
            ElementId = handleId,
            Action = value.Action,
            Value = value.Value,
            ExpectedTarget = value.ExpectedTarget,
        };
        ProtocolValidator.Validate(request);
        return request;
    }

    private static WaitOptions LimitWait(WaitOptions? wait, int remainingMs)
    {
        wait ??= new WaitOptions();
        return wait with { TimeoutMs = Math.Min(wait.TimeoutMs, remainingMs) };
    }

    private static T Deserialize<T>(JsonElement payload)
        where T : class
    {
        try
        {
            return payload.Deserialize<T>(StrictOptions) ?? throw new HostOperationException(
                "invalid_request", "The method payload is invalid.");
        }
        catch (JsonException exception)
        {
            throw new HostOperationException("invalid_request", "The method payload is invalid.", inner: exception);
        }
    }

    private static JsonSerializerOptions CreateStrictOptions()
    {
        var options = new JsonSerializerOptions(JsonDefaults.Options)
        {
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        };
        return options;
    }

    private sealed record EmptyPayload;
    private sealed record HandshakePayload
    {
        public string? Client { get; init; }
        public IReadOnlyList<string>? SupportedVersions { get; init; }
    }
    private sealed record ExecutablePayload
    {
        public string Path { get; init; } = string.Empty;
        public IReadOnlyList<string> Arguments { get; init; } = Array.Empty<string>();
    }
    private sealed record LaunchPayload
    {
        public ExecutablePayload? Executable { get; init; }
        public string? WorkingDirectory { get; init; }
        public Dictionary<string, string> Environment { get; init; } = new(StringComparer.OrdinalIgnoreCase);
        public string Desktop { get; init; } = "default";
        public bool WaitForWindow { get; init; } = true;
        public UiaLocator? Window { get; init; }
        public WaitOptions Wait { get; init; } = new();
    }
    private sealed record EndPayload
    {
        public WaitOptions Wait { get; init; } = new() { TimeoutMs = 10_000 };
    }
    private sealed record FindPayload
    {
        public UiaLocator Locator { get; init; } = new();
        public WaitOptions Wait { get; init; } = new();
    }
    private sealed record BatchPayload
    {
        public IReadOnlyList<UiaLocator> Clauses { get; init; } = Array.Empty<UiaLocator>();
    }
    private sealed record ActionPayload
    {
        public UiaAction Action { get; init; }
        public string? Value { get; init; }
        public UiaActionTargetExpectation? ExpectedTarget { get; init; }
    }
}
