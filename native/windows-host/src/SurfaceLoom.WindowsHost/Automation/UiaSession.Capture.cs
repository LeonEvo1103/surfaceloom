using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public sealed partial class UiaSession
{
    // UIA_E_TIMEOUT: UIA's own cross-process call timeout, surfaced by .NET as a COMException.
    private const int UiaTimeoutHResult = unchecked((int)0x80131505);

    /// <summary>
    /// Saves a PNG of only this session's application window (for example after a failed step). A window
    /// session captures exactly its bound top-level window; a process session captures the process's frontmost
    /// capturable window; a desktop session has no bound application and never captures the desktop.
    /// Read-only toward the target: no input is sent and minimized windows are not restored.
    /// </summary>
    public WindowsWindowCaptureResult CaptureWindow(string filePath, WindowsWindowCaptureOptions? options = null)
    {
        ThrowIfDisposed();
        var effective = options ?? new WindowsWindowCaptureOptions();
        if (Surface == SessionSurface.Desktop || ProcessId <= 0)
        {
            return WindowsWindowCaptureResult.NoWindow(
                "a desktop session is not bound to an application window; the desktop is never captured");
        }
        if (WindowsWindowCapturer.RejectInvalidRequest(ProcessId, filePath, effective) is { } invalid)
        {
            return invalid;
        }

        if (Surface == SessionSurface.Window)
        {
            var bound = ResolveBoundWindow(effective.Timeout, out var remaining);
            if (bound.Failure is { } failure)
            {
                return failure;
            }
            if (effective.WindowHandle is nint requested &&
                unchecked((int)(long)requested) != unchecked((int)(long)bound.Handle))
            {
                return WindowsWindowCaptureResult.Failure(
                    $"a window session captures only its bound window {WindowsWindowSelection.Hex(bound.Handle)}, not {WindowsWindowSelection.Hex(requested)}");
            }
            effective = effective with { WindowHandle = bound.Handle, Timeout = remaining };
        }

        return WindowsWindowCapturer.CaptureProcessWindow(ProcessId, filePath, effective);
    }

    /// <summary>
    /// Reads the bound root's native handle. A UIA property read can block on a hung provider, so it runs off
    /// this thread and spends from the capture budget; <paramref name="remaining"/> is what is left.
    /// </summary>
    private (nint Handle, WindowsWindowCaptureResult? Failure) ResolveBoundWindow(TimeSpan timeout, out TimeSpan remaining)
    {
        remaining = TimeSpan.Zero;
        var clock = Stopwatch.StartNew();
        var root = Root;
        var lookup = Task.Run(() => root.Current.NativeWindowHandle);
        int handle;
        try
        {
            if (!lookup.Wait(timeout))
            {
                return (0, WindowsWindowCaptureResult.Timeout("the bound UIA window did not report its native handle in time"));
            }
            handle = lookup.Result;
        }
        catch (AggregateException exception)
        {
            return (0, exception.InnerException switch
            {
                ElementNotAvailableException => WindowsWindowCaptureResult.NoWindow("the bound window is no longer available"),
                COMException { HResult: UiaTimeoutHResult } => WindowsWindowCaptureResult.Timeout(
                    "the bound UIA window did not report its native handle in time"),
                var inner => WindowsWindowCaptureResult.Failure(
                    $"the UIA provider failed while reading the bound window handle: {inner?.GetType().Name}"),
            });
        }
        if (handle == 0)
        {
            return (0, WindowsWindowCaptureResult.NoWindow("the bound UIA window exposes no native window handle"));
        }

        remaining = timeout - clock.Elapsed;
        return remaining < TimeSpan.FromMilliseconds(1)
            ? (0, WindowsWindowCaptureResult.Timeout("the UIA handle lookup used the whole capture timeout"))
            : (handle, null);
    }
}
