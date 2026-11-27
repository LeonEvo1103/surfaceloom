using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using static SurfaceLoom.WindowsHost.Automation.WindowsWindowCaptureNative;

namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>
/// Live Win32 half of window capture. All geometry is read under a per-monitor-v2 thread DPI context, so
/// rectangles and the bitmap are physical pixels regardless of the host process's own DPI awareness.
/// </summary>
internal static class WindowsWindowLiveCapture
{
    private const int MaximumWindows = 4_096;
    private const long MaximumPixels = 50_000_000;

    public static WindowsWindowCaptureDependencies Dependencies { get; } = new(
        InputDesktopInspector.Inspect,
        ListWindows,
        CaptureImage,
        WindowsPngFileStore.Write,
        WindowsPngFileStore.VerifiedByteCount,
        File.Exists,
        WindowsPngFileStore.Remove,
        () => DateTimeOffset.UtcNow);

    /// <summary>
    /// Top-level windows of <paramref name="processId"/>. <see cref="WindowsWindowDescriptor.ZOrder"/> is the index in
    /// the whole EnumWindows enumeration, which is z-order from the top; the cap counts only this process's windows.
    /// </summary>
    public static IReadOnlyList<WindowsWindowDescriptor> ListWindows(int processId)
    {
        var candidates = new List<(IntPtr Handle, int ZOrder)>();
        var index = 0;
        EnumWindowsProc callback = (window, _) =>
        {
            if (GetWindowThreadProcessId(window, out var owner) != 0 && unchecked((int)owner) == processId)
            {
                candidates.Add((window, index));
            }
            index++;
            return candidates.Count < MaximumWindows;
        };
        var previousContext = SetThreadDpiAwarenessContext(DpiAwarenessContextPerMonitorAwareV2);
        try
        {
            // A FALSE return also happens when the callback stops early; the collected prefix is still valid.
            _ = EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            var windows = new List<WindowsWindowDescriptor>(candidates.Count);
            foreach (var (handle, zOrder) in candidates)
            {
                if (Describe(handle, zOrder) is { } descriptor)
                {
                    windows.Add(descriptor);
                }
            }
            return windows;
        }
        finally
        {
            if (previousContext != IntPtr.Zero)
            {
                _ = SetThreadDpiAwarenessContext(previousContext);
            }
        }
    }

    /// <summary>
    /// Runs the probe, PrintWindow and PNG encoding on a dedicated background STA thread and waits at most
    /// <paramref name="timeout"/>. A worker stuck in a hung target is abandoned; it frees its own GDI objects
    /// when it eventually returns and never touches the destination file.
    /// </summary>
    public static WindowImageOutcome CaptureImage(WindowsWindowDescriptor window, TimeSpan timeout)
    {
        var clock = Stopwatch.StartNew();
        WindowImageOutcome? outcome = null;
        var worker = new Thread(() =>
        {
            WindowImageOutcome result;
            try
            {
                result = CaptureOnWorker(window, timeout, clock);
            }
            catch (Exception exception)
            {
                result = Failed($"capture threw {exception.GetType().Name}: {exception.Message}");
            }
            Volatile.Write(ref outcome, result);
            try
            {
                Dispatcher.FromThread(Thread.CurrentThread)?.InvokeShutdown();
            }
            catch (Exception)
            {
                // An exception escaping a background thread would terminate the process; the result is already set.
            }
        })
        {
            IsBackground = true,
            Name = "SurfaceLoom window capture",
        };
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();
        if (!worker.Join(timeout))
        {
            // The probe and the join share one deadline, so either stage may be the one that did not finish.
            return new(WindowImageOutcomeKind.TimedOut, null,
                "the responsiveness probe, PrintWindow or PNG encoding did not finish");
        }
        return Volatile.Read(ref outcome) ?? Failed("the capture worker produced no result");
    }

    private static WindowsWindowDescriptor? Describe(IntPtr window, int zOrder)
    {
        if (GetWindowThreadProcessId(window, out var processId) == 0 || !GetWindowRect(window, out var rect))
        {
            return null;
        }
        return new WindowsWindowDescriptor(
            window,
            unchecked((int)processId),
            zOrder,
            IsWindowVisible(window),
            IsCloakedOrUnknown(window),
            IsIconic(window),
            GetWindow(window, GwOwner),
            rect.Right - rect.Left,
            rect.Bottom - rect.Top);
    }

    private static WindowImageOutcome CaptureOnWorker(WindowsWindowDescriptor window, TimeSpan timeout, Stopwatch clock)
    {
        _ = SetThreadDpiAwarenessContext(DpiAwarenessContextPerMonitorAwareV2);
        var handle = window.Handle;
        if (!IsWindow(handle) || GetWindowThreadProcessId(handle, out var processId) == 0 ||
            unchecked((int)processId) != window.ProcessId)
        {
            return Unavailable("the selected window was destroyed before capture");
        }
        if (IsIconic(handle))
        {
            return Unavailable("the selected window was minimized before capture");
        }

        var remainingMs = (timeout - clock.Elapsed).TotalMilliseconds;
        if (remainingMs < 1)
        {
            return new(WindowImageOutcomeKind.TimedOut, null, "no time left for the responsiveness probe");
        }
        if (SendMessageTimeout(handle, WmNull, UIntPtr.Zero, IntPtr.Zero, SmtoAbortIfHung,
                (uint)remainingMs, out _) == IntPtr.Zero)
        {
            var error = Marshal.GetLastWin32Error();
            return error switch
            {
                0 or ErrorTimeout => new(WindowImageOutcomeKind.TimedOut, null,
                    "the window is hung or did not answer WM_NULL"),
                ErrorInvalidWindowHandle => Unavailable("the selected window was destroyed during the probe"),
                _ => Failed("the responsiveness probe failed", error),
            };
        }

        // The probe may have waited most of the budget; re-check what selection relied on before printing.
        if (IsIconic(handle) || !IsWindowVisible(handle) || IsCloakedOrUnknown(handle))
        {
            return Unavailable("the selected window was minimized, hidden or cloaked during the capture");
        }

        if (!GetWindowRect(handle, out var windowRect))
        {
            var error = Marshal.GetLastWin32Error();
            return error == ErrorInvalidWindowHandle
                ? Unavailable("the selected window was destroyed before capture")
                : Failed("GetWindowRect failed", error);
        }
        var width = windowRect.Right - windowRect.Left;
        var height = windowRect.Bottom - windowRect.Top;
        if (width <= 0 || height <= 0 || (long)width * height > MaximumPixels)
        {
            return Failed($"the window size {width}x{height} px is outside the capturable range");
        }

        var crop = VisibleFrame(handle, windowRect, width, height);
        var pixels = WindowsWindowPrinter.Print(handle, width, height, crop, out var failure);
        if (pixels is null)
        {
            return failure!;
        }

        var stride = crop.Width * 4;
        var (single, hex) = WindowsPngFileStore.SingleColor(pixels, crop.Width, crop.Height, stride);
        var source = BitmapSource.Create(crop.Width, crop.Height, 96, 96, PixelFormats.Bgr32, null, pixels, stride);
        source.Freeze();
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(source));
        using var png = new MemoryStream();
        encoder.Save(png);
        return new(WindowImageOutcomeKind.Image,
            new WindowImage(crop.Width, crop.Height, png.ToArray(), single, hex), null);
    }

    /// <summary>
    /// Crops away the invisible resize borders: DWM extended frame bounds are the visible window, expressed
    /// relative to the window rectangle that PrintWindow paints. Falls back to the whole rectangle.
    /// </summary>
    private static (int X, int Y, int Width, int Height) VisibleFrame(IntPtr handle, Rect windowRect, int width, int height)
    {
        if (DwmGetWindowAttributeRect(handle, DwmwaExtendedFrameBounds, out var frame, Marshal.SizeOf<Rect>()) < 0)
        {
            return (0, 0, width, height);
        }
        var left = Math.Max(frame.Left, windowRect.Left) - windowRect.Left;
        var top = Math.Max(frame.Top, windowRect.Top) - windowRect.Top;
        var right = Math.Min(frame.Right, windowRect.Right) - windowRect.Left;
        var bottom = Math.Min(frame.Bottom, windowRect.Bottom) - windowRect.Top;
        return right > left && bottom > top
            ? (left, top, right - left, bottom - top)
            : (0, 0, width, height);
    }

    /// <summary>A window whose cloak state cannot be read is treated as cloaked: never captured, and reported.</summary>
    private static bool IsCloakedOrUnknown(IntPtr window) =>
        DwmGetWindowAttributeInt(window, DwmwaCloaked, out var cloaked, sizeof(int)) < 0 || cloaked != 0;

    internal static WindowImageOutcome Failed(string reason, int? error = null) =>
        new(WindowImageOutcomeKind.Failed, null, reason, error);

    private static WindowImageOutcome Unavailable(string reason) =>
        new(WindowImageOutcomeKind.WindowUnavailable, null, reason);
}
