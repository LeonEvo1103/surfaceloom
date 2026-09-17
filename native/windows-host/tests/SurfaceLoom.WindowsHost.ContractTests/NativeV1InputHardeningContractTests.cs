using System.IO;
using System.Text;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static class NativeV1InputHardeningContractTests
{
    public static void SharedRawWireBoundaryVectorsAreStrict()
    {
        var filenames = new[]
        {
            "12-payload-depth-32.vector.json", "13-payload-depth-33.vector.json",
            "14-result-depth-32.vector.json", "15-result-depth-33.vector.json",
            "16-details-depth-32.vector.json", "17-details-depth-33.vector.json",
            "18-canonical-equivalent-keys.vector.json", "19-escaped-high-surrogate.vector.json",
            "20-escaped-low-surrogate.vector.json",
            "21-raw-array-depth-64-empty.vector.json", "22-raw-array-depth-64-value.vector.json",
            "23-raw-array-depth-65-empty.vector.json", "24-raw-array-depth-65-value.vector.json",
            "25-raw-object-depth-64-empty.vector.json", "26-raw-object-depth-64-value.vector.json",
            "27-raw-object-depth-65-empty.vector.json", "28-raw-object-depth-65-value.vector.json",
        };
        foreach (var filename in filenames)
        {
            var vectorPath = Path.Combine(AppContext.BaseDirectory, "fixtures", "native-v1", filename);
            using var vector = JsonDocument.Parse(File.ReadAllText(vectorPath));
            var root = vector.RootElement;
            var wire = root.GetProperty("wire").GetString()
                ?? throw new InvalidOperationException($"{filename} must contain raw wire text.");
            if (root.TryGetProperty("rawValid", out var rawValidProperty))
            {
                var rawValid = rawValidProperty.GetBoolean();
                Equal(rawValid ? 64 : 65, root.GetProperty("rawContainerDepth").GetInt32(),
                    $"{filename} must document the shared raw-container boundary.");
                if (rawValid)
                {
                    using var raw = NativeV1Parser.ParseFrame(wire);
                }
                else
                {
                    var rawFailure = Throws<NativeV1ProtocolException>(() => NativeV1Parser.ParseFrame(wire));
                    Equal("invalid_json", rawFailure.Code, $"{filename} must reject the 65th raw container.");
                }
                continue;
            }
            if (!root.GetProperty("valid").GetBoolean())
            {
                var failure = Throws<NativeV1ProtocolException>(() => NativeV1Parser.ParseFrame(wire));
                Equal(root.GetProperty("errorCode").GetString(), failure.Code,
                    $"{filename} must retain the shared error code.");
                continue;
            }

            using var message = NativeV1Parser.ParseFrame(wire);
            if (message.RootElement.GetProperty("type").GetString() == "request")
            {
                _ = NativeV1Parser.ParseRequest(message.RootElement);
            }
            if (root.TryGetProperty("expectedPayloadKeyUtf8Hex", out var expectedKeys))
            {
                var payload = message.RootElement.GetProperty("call").GetProperty("payload");
                var actual = payload.EnumerateObject()
                    .Select(property => Convert.ToHexString(Encoding.UTF8.GetBytes(property.Name)).ToLowerInvariant())
                    .ToArray();
                var expected = expectedKeys.EnumerateArray().Select(item => item.GetString()!).ToArray();
                True(actual.SequenceEqual(expected, StringComparer.Ordinal),
                    "Canonical-equivalent keys must remain distinct by exact UTF-8 bytes.");
            }
        }
    }

    public static void SharedDuplicateKeyVectorFailsClosed()
    {
        var vectorPath = Path.Combine(
            AppContext.BaseDirectory,
            "fixtures",
            "native-v1",
            "11-duplicate-json-key.vector.json");
        using var vector = JsonDocument.Parse(File.ReadAllText(vectorPath));
        var wire = vector.RootElement.GetProperty("wire").GetString()
            ?? throw new InvalidOperationException("Shared vector must contain raw wire text.");

        var parserFailure = Throws<NativeV1ProtocolException>(() => NativeV1Parser.ParseFrame(wire));
        Equal("invalid_json", parserFailure.Code,
            "The C# parser must match the shared duplicate-key error contract.");
        NoResponse(Encoding.UTF8.GetBytes(wire + "\n"),
            "A duplicate correlation key must close before protocol routing.");
    }

    public static void NestedDuplicateKeysFailClosed()
    {
        var wire = Handshake("nested-duplicate").Replace(
            "\"payload\":{}",
            "\"payload\":{\"name\":1,\"n\\u0061me\":2}",
            StringComparison.Ordinal);
        var exception = Throws<NativeV1ProtocolException>(() => NativeV1Parser.ParseFrame(wire));
        Equal("invalid_json", exception.Code,
            "Escaped-equivalent keys must be duplicate after JSON decoding.");
        NoResponse(Encoding.UTF8.GetBytes(wire + "\n"),
            "Method payload duplicates must fail before dispatch.");
    }

    public static void InvalidUtf8FailsClosed()
    {
        var prefix = Encoding.UTF8.GetBytes("{\"protocol\":\"surfaceloom.native\",\"padding\":\"");
        var suffix = Encoding.UTF8.GetBytes("\"}\n");
        var bytes = new byte[prefix.Length + 2 + suffix.Length];
        prefix.CopyTo(bytes, 0);
        bytes[prefix.Length] = 0xc3;
        bytes[prefix.Length + 1] = 0x28;
        suffix.CopyTo(bytes, prefix.Length + 2);

        NoResponse(bytes, "Malformed UTF-8 must not reach either protocol dispatcher.");
    }

    public static void EofResponsibilityIsExplicit()
    {
        NoResponse(
            Encoding.UTF8.GetBytes(
                "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"type\":\"request\"," +
                "\"id\":\"partial-launch\",\"deadline\":{\"timeoutMs\":1000},\"call\":{" +
                "\"name\":\"session.launch\",\"intent\":\"lifecycle\",\"operationId\":\"partial-operation\""),
            "EOF on a partial lifecycle frame must not invent an operation or cleanup receipt.");

        var complete = RunBytes(Encoding.UTF8.GetBytes(Handshake("delimiterless-eof")));
        Equal(string.Empty, complete.Diagnostics,
            "A complete final frame may use the contract's implicit LF accounting.");
        using var response = JsonDocument.Parse(complete.Output);
        True(response.RootElement.GetProperty("ok").GetBoolean(),
            "A complete delimiterless final frame must still dispatch.");
    }

    public static void CrlfAndMultipleFramesRemainBounded()
    {
        var input = Encoding.UTF8.GetBytes(
            Handshake("crlf-first") + "\r\n" + Handshake("lf-second") + "\n");
        var result = RunBytes(input);
        Equal(string.Empty, result.Diagnostics, "Valid CRLF/LF frames must not emit diagnostics.");
        var lines = result.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Equal(2, lines.Length, "Two complete NDJSON frames must produce two terminal responses.");
        using (var first = JsonDocument.Parse(lines[0]))
        using (var second = JsonDocument.Parse(lines[1]))
        {
            Equal("crlf-first", first.RootElement.GetProperty("id").GetString(),
                "CRLF framing must preserve the first id.");
            Equal("lf-second", second.RootElement.GetProperty("id").GetString(),
                "LF framing must preserve the second id.");
        }

        var oversized = Encoding.UTF8.GetBytes(
            "{\"protocol\":\"surfaceloom.native\",\"padding\":\"" +
            new string('x', NativeV1Protocol.MaxMessageBytes) + "\"}\n");
        NoResponse(oversized, "The raw byte reader must enforce the frame cap before routing.");

        using var unterminated = new EndlessNonDelimiterStream();
        var bounded = RunStream(unterminated);
        Equal(string.Empty, bounded.Output, "An unterminated oversized frame must never dispatch.");
        True(bounded.Diagnostics.Length > 0, "An oversized stream must leave one safe diagnostic.");
        True(unterminated.BytesRead <= NativeV1Protocol.MaxMessageBytes,
            "The reader must stop at the cap instead of draining an unbounded frame.");
    }

    public static void ByteInputPreservesLegacyBoundary()
    {
        const string legacy =
            "{\"protocolVersion\":\"0.2\",\"id\":\"legacy-bytes\",\"method\":\"host.handshake\",\"params\":{}}\n";
        var result = RunBytes(Encoding.UTF8.GetBytes(legacy));
        Equal(string.Empty, result.Diagnostics, "A valid legacy byte frame must remain routable.");
        using var response = JsonDocument.Parse(result.Output);
        Equal("0.2", response.RootElement.GetProperty("protocolVersion").GetString(),
            "The strict byte reader must not relabel legacy responses.");
        True(!response.RootElement.TryGetProperty("protocol", out _),
            "The legacy byte path must not emit a shared v1 envelope.");
    }

    private static string Handshake(string id) =>
        "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"type\":\"request\"," +
        $"\"id\":\"{id}\",\"deadline\":{{\"timeoutMs\":1000}},\"call\":{{" +
        "\"name\":\"host.handshake\",\"intent\":\"observe\",\"scope\":{\"kind\":\"bootstrap\"}," +
        "\"payload\":{}}}";

    private static void NoResponse(byte[] bytes, string message)
    {
        var result = RunBytes(bytes);
        Equal(string.Empty, result.Output, message);
        True(result.Diagnostics.Length > 0,
            "A connection-level rejection must leave one safe diagnostic.");
    }

    private static (string Output, string Diagnostics) RunBytes(byte[] bytes)
    {
        using var input = new MemoryStream(bytes, writable: false);
        return RunStream(input);
    }

    private static (string Output, string Diagnostics) RunStream(Stream input)
    {
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();
        new NdjsonHost(input, output, diagnostics).Run(CancellationToken.None);
        return (output.ToString(), diagnostics.ToString());
    }

    private static T Throws<T>(Action action)
        where T : Exception
    {
        try
        {
            action();
        }
        catch (T exception)
        {
            return exception;
        }
        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }

    private static void True(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{message} Expected: {expected}; actual: {actual}.");
        }
    }

    private sealed class EndlessNonDelimiterStream : Stream
    {
        public int BytesRead { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (count == 0) return 0;
            buffer[offset] = (byte)'x';
            BytesRead++;
            return 1;
        }
        public override int ReadByte()
        {
            BytesRead++;
            return 'x';
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
