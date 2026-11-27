using System.Globalization;
using System.IO;

namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>File-system and pixel-fact helpers for window captures.</summary>
internal static class WindowsPngFileStore
{
    // FileMode.CreateNew surfaces an existing file as IOException with HRESULT_FROM_WIN32(ERROR_FILE_EXISTS).
    private const int ErrorFileExists = 80;
    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>
    /// Creates missing parent directories, then writes with <see cref="FileMode.CreateNew"/> so an existing file
    /// (including one created concurrently after the pre-check) is never overwritten or removed.
    /// </summary>
    public static PngWriteOutcome Write(string filePath, byte[] png)
    {
        try
        {
            var directory = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
            or NotSupportedException or ArgumentException)
        {
            // Kept apart from the write so a parent path that is a file is never misreported as an existing destination.
            return new PngWriteOutcome(false, false, false,
                "creating the destination directory failed: " + exception.GetType().Name + ": " + exception.Message);
        }

        var created = false;
        try
        {
            using var stream = new FileStream(filePath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            created = true;
            stream.Write(png, 0, png.Length);
            return new PngWriteOutcome(true, true, false, null);
        }
        catch (IOException exception) when (!created && (exception.HResult & 0xFFFF) == ErrorFileExists)
        {
            return new PngWriteOutcome(false, false, true, "destination already exists");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
            or NotSupportedException or ArgumentException)
        {
            return new PngWriteOutcome(false, created, false, exception.GetType().Name + ": " + exception.Message);
        }
    }

    /// <summary>Returns the byte count only for an existing file longer than, and starting with, the PNG signature.</summary>
    public static long? VerifiedByteCount(string filePath)
    {
        try
        {
            var info = new FileInfo(filePath);
            if (!info.Exists || info.Length <= PngSignature.Length)
            {
                return null;
            }

            using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            Span<byte> header = stackalloc byte[8];
            stream.ReadExactly(header);
            return header.SequenceEqual(PngSignature) ? info.Length : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
            or NotSupportedException or ArgumentException)
        {
            return null;
        }
    }

    public static void Remove(string filePath)
    {
        try
        {
            File.Delete(filePath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
            or NotSupportedException or ArgumentException)
        {
            // Best effort: a failed cleanup must not mask the original capture failure.
        }
    }

    /// <summary>
    /// Inspects top-down 32-bit BGRX rows (alpha ignored, as PrintWindow leaves it undefined) and reports whether
    /// every pixel shares one RGB value.
    /// </summary>
    public static (bool IsSingleColor, string? Hex) SingleColor(ReadOnlySpan<byte> bgrx, int width, int height, int stride)
    {
        if (width <= 0 || height <= 0 || stride < width * 4 || bgrx.Length < checked((height - 1) * stride + width * 4))
        {
            return (false, null);
        }

        var b = bgrx[0];
        var g = bgrx[1];
        var r = bgrx[2];
        for (var y = 0; y < height; y++)
        {
            var row = bgrx.Slice(y * stride, width * 4);
            for (var x = 0; x < row.Length; x += 4)
            {
                if (row[x] != b || row[x + 1] != g || row[x + 2] != r)
                {
                    return (false, null);
                }
            }
        }
        return (true, string.Create(CultureInfo.InvariantCulture, $"#{r:X2}{g:X2}{b:X2}"));
    }
}
