using System.Buffers;
using System.Text;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Host;

internal sealed record NativeV1OutboundFrame(
    string Line,
    int WireBytes,
    NativeV1Response Response);

internal static class NativeV1OutboundSerializer
{
    public static NativeV1OutboundFrame Serialize(NativeV1Response response)
    {
        var buffer = new BoundedBufferWriter(NativeV1Protocol.MaxMessageBytes - 1);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            JsonSerializer.Serialize(writer, response, JsonDefaults.Options);
            writer.Flush();
        }
        var line = Encoding.UTF8.GetString(buffer.WrittenSpan) + "\n";
        return new NativeV1OutboundFrame(line, buffer.WrittenCount + 1, response);
    }

    private sealed class BoundedBufferWriter : IBufferWriter<byte>
    {
        private readonly byte[] buffer;
        private int written;

        public BoundedBufferWriter(int capacity)
        {
            buffer = new byte[capacity];
        }

        public int WrittenCount => written;
        public ReadOnlySpan<byte> WrittenSpan => buffer.AsSpan(0, written);

        public void Advance(int count)
        {
            if (count < 0 || count > buffer.Length - written)
            {
                throw new NativeV1FrameLimitException();
            }
            written += count;
        }

        public Memory<byte> GetMemory(int sizeHint = 0)
        {
            RequireCapacity(sizeHint);
            return buffer.AsMemory(written);
        }

        public Span<byte> GetSpan(int sizeHint = 0)
        {
            RequireCapacity(sizeHint);
            return buffer.AsSpan(written);
        }

        private void RequireCapacity(int sizeHint)
        {
            var required = Math.Max(1, sizeHint);
            if (required > buffer.Length - written)
            {
                throw new NativeV1FrameLimitException();
            }
        }
    }
}

internal sealed class NativeV1FrameLimitException : Exception;
