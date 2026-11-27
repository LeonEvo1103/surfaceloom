using System.Globalization;
using System.IO;

namespace SurfaceLoom.WindowsHost.Automation;

internal enum WindowImageOutcomeKind
{
    Image,
    WindowUnavailable,
    Failed,
    TimedOut,
}

/// <summary>Encoded PNG bytes for one window plus facts measured on its raw pixels.</summary>
internal sealed record WindowImage(int PixelWidth, int PixelHeight, byte[] Png, bool IsSingleColor, string? SingleColorHex);

internal sealed record WindowImageOutcome(
    WindowImageOutcomeKind Kind,
    WindowImage? Image,
    string? Reason,
    int? Win32Error = null);

internal sealed record PngWriteOutcome(bool Succeeded, bool CreatedFile, bool AlreadyExisted, string? Error);

/// <summary>Injection seam: every side effect of a capture goes through here.</summary>
internal sealed record WindowsWindowCaptureDependencies(
    Func<InputDesktopInspection> InspectInputDesktop,
    Func<int, IReadOnlyList<WindowsWindowDescriptor>> ListWindows,
    Func<WindowsWindowDescriptor, TimeSpan, WindowImageOutcome> CaptureImage,
    Func<string, byte[], PngWriteOutcome> WritePng,
    Func<string, long?> VerifiedPngByteCount,
    Func<string, bool> FileExists,
    Action<string> RemoveFile,
    Func<DateTimeOffset> Now);

/// <summary>
/// Captures exactly one top-level window of a bound process into a new PNG file. The image comes from
/// PrintWindow(PW_RENDERFULLCONTENT) on the window itself, never from the screen DC, so overlapping windows
/// and the rest of the desktop are never included. This is a library API; it is not exposed over NDJSON.
/// </summary>
public static class WindowsWindowCapturer
{
    public static WindowsWindowCaptureResult CaptureProcessWindow(
        int processId,
        string filePath,
        WindowsWindowCaptureOptions? options = null) =>
        Capture(processId, filePath, options ?? new WindowsWindowCaptureOptions(), WindowsWindowLiveCapture.Dependencies);

    /// <summary>Checks that need no desktop, window or file-system access; null when the request is well-formed.</summary>
    internal static WindowsWindowCaptureResult? RejectInvalidRequest(
        int processId,
        string filePath,
        WindowsWindowCaptureOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (processId <= 0)
        {
            return WindowsWindowCaptureResult.NoWindow("no bound application process");
        }
        if (string.IsNullOrWhiteSpace(filePath) || !Path.IsPathFullyQualified(filePath))
        {
            return WindowsWindowCaptureResult.Failure("destination must be a fully qualified file path");
        }
        if (options.Timeout <= TimeSpan.Zero || options.Timeout > WindowsWindowCaptureOptions.MaximumTimeout)
        {
            return WindowsWindowCaptureResult.Failure(string.Create(CultureInfo.InvariantCulture,
                $"timeout must be greater than zero and at most {WindowsWindowCaptureOptions.MaximumTimeout.TotalSeconds:0} s"));
        }
        return null;
    }

    internal static WindowsWindowCaptureResult Capture(
        int processId,
        string filePath,
        WindowsWindowCaptureOptions options,
        WindowsWindowCaptureDependencies dependencies)
    {
        ArgumentNullException.ThrowIfNull(dependencies);
        if (RejectInvalidRequest(processId, filePath, options) is { } invalid)
        {
            return invalid;
        }

        var desktop = dependencies.InspectInputDesktop();
        if (!desktop.Accessible)
        {
            return WindowsWindowCaptureResult.Unavailable(
                "the input desktop cannot be opened; the session is probably locked or on a secure desktop",
                desktop.Win32Error);
        }
        if (!string.Equals(desktop.Name, "Default", StringComparison.OrdinalIgnoreCase))
        {
            return WindowsWindowCaptureResult.Unavailable(
                $"the active input desktop is '{desktop.Name}', not the default desktop; nothing was captured");
        }

        if (dependencies.FileExists(filePath))
        {
            return WindowsWindowCaptureResult.Failure("destination already exists and is never overwritten");
        }

        var selection = WindowsWindowSelection.Select(
            dependencies.ListWindows(processId),
            processId,
            options.MinimumWidth,
            options.MinimumHeight,
            options.WindowHandle);
        if (selection.Window is not { } window)
        {
            return WindowsWindowCaptureResult.NoWindow(selection.Reason ?? "no capturable window");
        }

        var outcome = dependencies.CaptureImage(window, options.Timeout);
        switch (outcome.Kind)
        {
            case WindowImageOutcomeKind.TimedOut:
                return WindowsWindowCaptureResult.Timeout(string.Create(CultureInfo.InvariantCulture,
                    $"window {WindowsWindowSelection.Hex(window.Handle)} did not finish within {options.Timeout.TotalMilliseconds:0} ms: {outcome.Reason}"));
            case WindowImageOutcomeKind.WindowUnavailable:
                return WindowsWindowCaptureResult.NoWindow(outcome.Reason ?? "the selected window disappeared");
            case WindowImageOutcomeKind.Failed:
                return WindowsWindowCaptureResult.Failure(outcome.Reason ?? "window capture failed", outcome.Win32Error);
        }

        var image = outcome.Image;
        if (image is null || image.PixelWidth <= 0 || image.PixelHeight <= 0 || image.Png.Length == 0)
        {
            return WindowsWindowCaptureResult.Failure("the window image has no pixels");
        }
        if (image.PixelWidth < options.MinimumWidth || image.PixelHeight < options.MinimumHeight)
        {
            // Selection measured the window rectangle; the image is the visible frame without invisible borders.
            return WindowsWindowCaptureResult.NoWindow(string.Create(CultureInfo.InvariantCulture,
                $"the visible frame of window {WindowsWindowSelection.Hex(window.Handle)} is {image.PixelWidth}x{image.PixelHeight} px, smaller than {options.MinimumWidth}x{options.MinimumHeight} px"));
        }

        var write = dependencies.WritePng(filePath, image.Png);
        if (!write.Succeeded)
        {
            if (write.CreatedFile)
            {
                dependencies.RemoveFile(filePath);
            }
            return WindowsWindowCaptureResult.Failure(write.AlreadyExisted
                ? "destination already exists and is never overwritten"
                : $"writing PNG failed: {write.Error}");
        }

        if (dependencies.VerifiedPngByteCount(filePath) is not long byteCount || byteCount <= 0)
        {
            dependencies.RemoveFile(filePath);
            return WindowsWindowCaptureResult.Failure("the written file is not a non-empty PNG");
        }

        return WindowsWindowCaptureResult.Captured(new WindowsWindowCapture(
            filePath,
            byteCount,
            image.PixelWidth,
            image.PixelHeight,
            window.Handle,
            processId,
            dependencies.Now(),
            image.IsSingleColor,
            image.SingleColorHex));
    }
}
