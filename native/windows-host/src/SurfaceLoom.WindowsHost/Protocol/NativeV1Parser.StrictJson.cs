using System.Text.Json;

namespace SurfaceLoom.WindowsHost.Protocol;

public static partial class NativeV1Parser
{
    private const int MaxRawContainerDepth = 64;

    private static void ValidateSemanticMembers(JsonElement root)
    {
        if (!root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String)
        {
            return;
        }
        if (type.GetString() == "request" &&
            root.TryGetProperty("call", out var call) && call.ValueKind == JsonValueKind.Object &&
            call.TryGetProperty("payload", out var payload))
        {
            ValidateSemanticValue(payload, 0);
            return;
        }
        if (type.GetString() != "response" ||
            !root.TryGetProperty("ok", out var ok) ||
            ok.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            return;
        }
        if (ok.GetBoolean() && root.TryGetProperty("result", out var result))
        {
            ValidateSemanticValue(result, 0);
        }
        else if (!ok.GetBoolean() &&
                 root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object &&
                 error.TryGetProperty("details", out var details))
        {
            ValidateSemanticValue(details, 0);
        }
    }

    private static void ValidateSemanticValue(JsonElement value, int depth)
    {
        if (depth > 32)
        {
            throw Invalid("invalid_message", "invalidRequest", "JSON value exceeds the nesting limit.");
        }
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                ValidateSemanticValue(property.Value, depth + 1);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray())
            {
                ValidateSemanticValue(item, depth + 1);
            }
        }
    }

    private static void RejectInvalidUnicodeScalars(string source)
    {
        var inString = false;
        for (var index = 0; index < source.Length; index++)
        {
            var character = source[index];
            if (!inString)
            {
                if (character == '"') inString = true;
                continue;
            }
            if (character == '"')
            {
                inString = false;
                continue;
            }
            if (character == '\\')
            {
                if (++index >= source.Length || source[index] != 'u') continue;
                if (!TryReadHexQuad(source, index + 1, out var first)) continue;
                index += 4;
                if (first is >= 0xD800 and <= 0xDBFF)
                {
                    if (index + 6 >= source.Length || source[index + 1] != '\\' || source[index + 2] != 'u' ||
                        !TryReadHexQuad(source, index + 3, out var second) || second is < 0xDC00 or > 0xDFFF)
                    {
                        throw Invalid("invalid_json", "protocol", "Wire frame contains an unpaired surrogate.");
                    }
                    index += 6;
                }
                else if (first is >= 0xDC00 and <= 0xDFFF)
                {
                    throw Invalid("invalid_json", "protocol", "Wire frame contains an unpaired surrogate.");
                }
                continue;
            }
            if (char.IsHighSurrogate(character))
            {
                if (index + 1 >= source.Length || !char.IsLowSurrogate(source[index + 1]))
                {
                    throw Invalid("invalid_json", "protocol", "Wire frame contains an unpaired surrogate.");
                }
                index++;
            }
            else if (char.IsLowSurrogate(character))
            {
                throw Invalid("invalid_json", "protocol", "Wire frame contains an unpaired surrogate.");
            }
        }
    }

    private static bool TryReadHexQuad(string source, int offset, out int value)
    {
        value = 0;
        if (offset + 4 > source.Length) return false;
        for (var index = offset; index < offset + 4; index++)
        {
            var digit = source[index] switch
            {
                >= '0' and <= '9' => source[index] - '0',
                >= 'A' and <= 'F' => source[index] - 'A' + 10,
                >= 'a' and <= 'f' => source[index] - 'a' + 10,
                _ => -1,
            };
            if (digit < 0) return false;
            value = value * 16 + digit;
        }
        return true;
    }
}
