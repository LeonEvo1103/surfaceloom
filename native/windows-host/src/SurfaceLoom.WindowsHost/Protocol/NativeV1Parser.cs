using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SurfaceLoom.WindowsHost.Protocol;

public static partial class NativeV1Parser
{
    public static JsonDocument ParseFrame(string line, int delimiterBytes = 1)
    {
        ArgumentNullException.ThrowIfNull(line);
        if (delimiterBytes is < 1 or > 2)
        {
            throw new ArgumentOutOfRangeException(nameof(delimiterBytes));
        }
        if (Encoding.UTF8.GetByteCount(line) + delimiterBytes > NativeV1Protocol.MaxMessageBytes)
        {
            throw Invalid("message_too_large", "protocol", "Wire frame exceeds the protocol byte limit.");
        }
        if (line.Length == 0 || line.Contains('\n') || line.Contains('\r'))
        {
            throw Invalid("invalid_frame", "protocol", "Wire frame must contain exactly one JSON object.");
        }

        try
        {
            var document = JsonDocument.Parse(line, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 40,
            });
            try
            {
                if (IsNativeV1Envelope(document.RootElement))
                {
                    RejectDuplicateObjectKeys(document.RootElement);
                }
                return document;
            }
            catch
            {
                document.Dispose();
                throw;
            }
        }
        catch (NativeV1ProtocolException)
        {
            throw;
        }
        catch (JsonException)
        {
            throw Invalid("invalid_json", "protocol", "Wire frame is not valid JSON.");
        }
    }

    public static bool IsNativeV1Envelope(JsonElement root) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty("protocol", out _);

    public static NativeV1Request ParseRequest(JsonElement root)
    {
        var id = ReadHeader(root, "request", ["protocol", "version", "type", "id", "deadline", "call"]);
        var deadline = RequireObject(root, "deadline", ["timeoutMs"], id);
        var timeoutMs = ReadInteger(deadline, "timeoutMs", 0, NativeV1Protocol.MaxDeadlineMs, id);
        var call = ParseCall(RequireObject(root, "call", ["name", "intent", "scope", "payload", "operationId"], id), id);
        return new NativeV1Request(id, timeoutMs, call);
    }

    public static NativeV1Cancel ParseCancel(JsonElement root)
    {
        var id = ReadHeader(root, "cancel", ["protocol", "version", "type", "id", "requestId", "reason"]);
        var requestId = ReadIdentifier(root, "requestId", id);
        if (string.Equals(id, requestId, StringComparison.Ordinal))
        {
            throw Invalid("invalid_message", "invalidRequest", "Cancellation id must differ from requestId.", id);
        }
        var reason = ReadChoice(root, "reason", ["caller", "deadline", "shutdown"], id);
        return new NativeV1Cancel(id, requestId, reason);
    }

    public static string ReadMessageType(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var type) ||
            type.ValueKind != JsonValueKind.String)
        {
            throw Invalid("invalid_message", "invalidRequest", "message.type is required.");
        }
        return type.GetString()!;
    }

    public static string? TryReadMessageId(JsonElement root) =>
        root.ValueKind == JsonValueKind.Object ? TryReadIdentifier(root, "id") : null;

    private static NativeV1Call ParseCall(JsonElement call, string requestId)
    {
        var name = ReadText(call, "name", requestId);
        if (!MethodNameRegex().IsMatch(name))
        {
            throw Invalid("invalid_message", "invalidRequest", "call.name must be namespaced.", requestId);
        }
        var intent = ReadChoice(call, "intent", ["observe", "mutate", "lifecycle"], requestId);
        var scope = ParseScope(RequireObject(call, "scope", ["kind", "hostInstanceId", "sessionId", "handleId"], requestId), requestId);
        if (!call.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
        {
            throw Invalid("invalid_message", "invalidRequest", "call.payload must be an object.", requestId);
        }
        string? operationId = null;
        if (call.TryGetProperty("operationId", out _))
        {
            operationId = ReadIdentifier(call, "operationId", requestId);
        }
        if (intent == "observe" && operationId is not null)
        {
            throw Invalid("invalid_message", "invalidRequest", "Observe calls must not carry operationId.", requestId);
        }
        if (intent != "observe" && operationId is null)
        {
            throw Invalid("invalid_message", "invalidRequest", "Mutate and lifecycle calls require operationId.", requestId);
        }
        if ((scope.Kind == "bootstrap") != (name == HostProtocol.Handshake))
        {
            throw Invalid("invalid_message", "invalidRequest", "Only host.handshake may use bootstrap scope.", requestId);
        }
        if (name == HostProtocol.Handshake && intent != "observe")
        {
            throw Invalid("invalid_message", "invalidRequest", "host.handshake must be observe/bootstrap.", requestId);
        }
        if (name == HostProtocol.LaunchSession && (intent != "lifecycle" || scope.Kind != "host"))
        {
            throw Invalid("invalid_message", "invalidRequest", "session.launch must be lifecycle/host.", requestId);
        }
        return new NativeV1Call(name, intent, scope, payload.Clone(), operationId);
    }

    private static NativeV1Scope ParseScope(JsonElement scope, string requestId)
    {
        var kind = ReadChoice(scope, "kind", ["bootstrap", "host", "session", "handle"], requestId);
        var allowed = kind switch
        {
            "bootstrap" => new[] { "kind" },
            "host" => ["kind", "hostInstanceId"],
            "session" => ["kind", "hostInstanceId", "sessionId"],
            _ => new[] { "kind", "hostInstanceId", "sessionId", "handleId" },
        };
        RequireOnlyProperties(scope, "call.scope", allowed, requestId);
        return new NativeV1Scope(
            kind,
            kind == "bootstrap" ? null : ReadIdentifier(scope, "hostInstanceId", requestId),
            kind is "session" or "handle" ? ReadIdentifier(scope, "sessionId", requestId) : null,
            kind == "handle" ? ReadIdentifier(scope, "handleId", requestId) : null);
    }

    private static string ReadHeader(JsonElement root, string expectedType, IReadOnlyCollection<string> fields)
    {
        RequireOnlyProperties(root, "message", fields, "invalid");
        var recoverableId = TryReadIdentifier(root, "id") ?? "invalid";
        var protocol = ReadText(root, "protocol", recoverableId);
        if (protocol != NativeV1Protocol.Name)
        {
            throw Invalid("unsupported_protocol", "protocol", "Unsupported native protocol.", recoverableId);
        }
        var version = ReadText(root, "version", recoverableId);
        if (version != NativeV1Protocol.Version)
        {
            throw Invalid("unsupported_version", "protocol", "Unsupported native protocol version.", recoverableId,
                new { supported = new[] { NativeV1Protocol.Version } });
        }
        var id = ReadIdentifier(root, "id", recoverableId);
        if (ReadText(root, "type", id) != expectedType)
        {
            throw Invalid("invalid_message", "invalidRequest", $"Expected a {expectedType} message.", id);
        }
        return id;
    }

    private static JsonElement RequireObject(
        JsonElement parent,
        string property,
        IReadOnlyCollection<string> fields,
        string requestId)
    {
        if (!parent.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Object)
        {
            throw Invalid("invalid_message", "invalidRequest", $"{property} must be an object.", requestId);
        }
        RequireOnlyProperties(value, property, fields, requestId);
        return value;
    }

    private static void RequireOnlyProperties(
        JsonElement value,
        string label,
        IReadOnlyCollection<string> fields,
        string requestId)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw Invalid("invalid_message", "invalidRequest", $"{label} must be an object.", requestId);
        }
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
        {
            if (!seen.Add(property.Name) || !fields.Contains(property.Name, StringComparer.Ordinal))
            {
                throw Invalid("invalid_message", "invalidRequest", $"{label} contains an unknown or duplicate field.", requestId);
            }
        }
    }

    private static int ReadInteger(JsonElement parent, string property, int minimum, int maximum, string requestId)
    {
        if (!parent.TryGetProperty(property, out var value) || !value.TryGetInt32(out var result) ||
            result < minimum || result > maximum)
        {
            throw Invalid("invalid_message", "invalidRequest", $"{property} is outside its allowed range.", requestId);
        }
        return result;
    }

    private static string ReadChoice(JsonElement parent, string property, string[] choices, string requestId)
    {
        var value = ReadText(parent, property, requestId);
        if (!choices.Contains(value, StringComparer.Ordinal))
        {
            throw Invalid("invalid_message", "invalidRequest", $"{property} is not supported.", requestId);
        }
        return value;
    }

    private static string ReadIdentifier(JsonElement parent, string property, string requestId)
    {
        var value = ReadText(parent, property, requestId);
        if (!IdentifierRegex().IsMatch(value))
        {
            throw Invalid("invalid_message", "invalidRequest", $"{property} is not a wire identifier.", requestId);
        }
        return value;
    }

    private static string? TryReadIdentifier(JsonElement parent, string property)
    {
        if (!parent.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }
        var text = value.GetString();
        return text is not null && IdentifierRegex().IsMatch(text) ? text : null;
    }

    private static string ReadText(JsonElement parent, string property, string requestId)
    {
        if (!parent.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw Invalid("invalid_message", "invalidRequest", $"{property} must be a string.", requestId);
        }
        var text = value.GetString()!;
        if (text.Length == 0 || Encoding.UTF8.GetByteCount(text) > 128 || text.Contains('\0') ||
            text.Contains('\r') || text.Contains('\n'))
        {
            throw Invalid("invalid_message", "invalidRequest", $"{property} must be a bounded single-line string.", requestId);
        }
        return text;
    }

    private static NativeV1ProtocolException Invalid(
        string code,
        string category,
        string message,
        string requestId = "invalid",
        object? details = null) => new(code, category, message, requestId, details);

    private static void RejectDuplicateObjectKeys(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!keys.Add(property.Name))
                {
                    throw Invalid(
                        "invalid_json",
                        "protocol",
                        "Wire frame contains a duplicate object key.");
                }
                RejectDuplicateObjectKeys(property.Value);
            }
            return;
        }
        if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray())
            {
                RejectDuplicateObjectKeys(item);
            }
        }
    }

    [GeneratedRegex("^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$", RegexOptions.CultureInvariant)]
    private static partial Regex IdentifierRegex();

    [GeneratedRegex("^[a-z][a-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+$", RegexOptions.CultureInvariant)]
    private static partial Regex MethodNameRegex();
}
