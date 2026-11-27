using System.Runtime.InteropServices;
using static SurfaceLoom.WindowsHost.Automation.WindowsWindowCaptureNative;

namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>
/// Asks one window to render itself into a private memory DC with PrintWindow(PW_RENDERFULLCONTENT).
/// No screen DC is read, so other windows covering the target never appear in the image.
/// </summary>
internal static class WindowsWindowPrinter
{
    /// <summary>
    /// Returns top-down 32-bit BGRX pixels of <paramref name="crop"/> (stride = crop width * 4), or null with
    /// <paramref name="failure"/> set. The memory DC and DIB section are always released before returning.
    /// </summary>
    public static byte[]? Print(
        IntPtr window,
        int width,
        int height,
        (int X, int Y, int Width, int Height) crop,
        out WindowImageOutcome? failure)
    {
        failure = null;
        var memoryDc = CreateCompatibleDC(IntPtr.Zero);
        if (memoryDc == IntPtr.Zero)
        {
            failure = WindowsWindowLiveCapture.Failed("CreateCompatibleDC failed", Marshal.GetLastWin32Error());
            return null;
        }

        var bitmap = IntPtr.Zero;
        var previousObject = IntPtr.Zero;
        try
        {
            var info = new BitmapInfo
            {
                Header = new BitmapInfoHeader
                {
                    Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(),
                    Width = width,
                    Height = -height, // negative height = top-down rows
                    Planes = 1,
                    BitCount = 32,
                    Compression = BiRgb,
                },
            };
            bitmap = CreateDIBSection(memoryDc, ref info, DibRgbColors, out var bits, IntPtr.Zero, 0);
            if (bitmap == IntPtr.Zero || bits == IntPtr.Zero)
            {
                failure = WindowsWindowLiveCapture.Failed("CreateDIBSection failed", Marshal.GetLastWin32Error());
                return null;
            }

            previousObject = SelectObject(memoryDc, bitmap);
            if (previousObject == IntPtr.Zero)
            {
                failure = WindowsWindowLiveCapture.Failed("SelectObject failed for the capture bitmap");
                return null;
            }

            if (!PrintWindow(window, memoryDc, PwRenderFullContent))
            {
                failure = WindowsWindowLiveCapture.Failed("PrintWindow returned FALSE");
                return null;
            }

            // DIB section memory may still have pending GDI drawing until it is flushed.
            _ = GdiFlush();
            var sourceStride = checked(width * 4);
            var cropStride = checked(crop.Width * 4);
            var pixels = new byte[checked(cropStride * crop.Height)];
            for (var row = 0; row < crop.Height; row++)
            {
                var sourceOffset = checked((crop.Y + row) * sourceStride + crop.X * 4);
                Marshal.Copy(IntPtr.Add(bits, sourceOffset), pixels, row * cropStride, cropStride);
            }
            return pixels;
        }
        finally
        {
            if (previousObject != IntPtr.Zero)
            {
                _ = SelectObject(memoryDc, previousObject);
            }
            if (bitmap != IntPtr.Zero)
            {
                _ = DeleteObject(bitmap);
            }
            _ = DeleteDC(memoryDc);
        }
    }
}
