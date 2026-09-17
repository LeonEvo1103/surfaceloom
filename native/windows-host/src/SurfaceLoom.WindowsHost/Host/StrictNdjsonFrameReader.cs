using System.IO;
using System.Text;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Host;

internal sealed class StrictNdjsonFrameReader
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private readonly Stream input;

    public StrictNdjsonFrameReader(Stream input)
    {
        this.input = input;
    }

    public NdjsonWireLine? ReadLine()
    {
        using var bytes = new MemoryStream();
        while (true)
        {
            var next = input.ReadByte();
            if (next < 0)
            {
                return bytes.Length == 0 ? null : Decode(bytes, delimiterBytes: 1);
            }
            if (next == '\n')
            {
                var delimiterBytes = bytes.Length > 0 && LastByte(bytes) == '\r' ? 2 : 1;
                return Decode(bytes, delimiterBytes);
            }
            // At least one LF byte (actual or implicit at EOF) is part of every
            // frame. Once content already occupies max-1 bytes, another
            // non-delimiter byte proves overflow and intake can close without
            // draining an attacker-controlled unterminated line.
            if (bytes.Length >= NativeV1Protocol.MaxMessageBytes - 1)
            {
                return new NdjsonWireLine(string.Empty, 1, true);
            }
            bytes.WriteByte((byte)next);
        }
    }

    private static NdjsonWireLine Decode(MemoryStream bytes, int delimiterBytes)
    {
        var length = checked((int)bytes.Length);
        var buffer = bytes.GetBuffer();
        if (delimiterBytes == 2)
        {
            length--;
        }
        return new NdjsonWireLine(StrictUtf8.GetString(buffer, 0, length), delimiterBytes, false);
    }

    private static byte LastByte(MemoryStream stream)
    {
        return stream.GetBuffer()[checked((int)stream.Length - 1)];
    }
}

internal sealed record NdjsonWireLine(
    string Line,
    int DelimiterBytes,
    bool ExceededByteLimit);
