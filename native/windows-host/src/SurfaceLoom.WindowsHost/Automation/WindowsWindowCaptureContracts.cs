namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>Typed outcome kind of a bound-window capture.</summary>
public enum WindowsWindowCaptureOutcome
{
    /// <summary>A verified PNG of exactly one window of the bound process exists on disk.</summary>
    Captured,

    /// <summary>The bound process has no capturable window (gone, minimized, cloaked, hidden or too small).</summary>
    NoCapturableWindow,

    /// <summary>The input desktop is not the readable default desktop (locked session, UAC Secure Desktop, ...).</summary>
    EnvironmentUnavailable,

    /// <summary>The capture or the PNG file could not be produced.</summary>
    Failed,

    /// <summary>The window did not respond, or rendering did not finish, within the capture timeout.</summary>
    TimedOut,
}

/// <summary>
/// Facts about a PNG of exactly one top-level window owned by the bound process, verified on disk
/// (non-empty, PNG signature) after writing. Pixel sizes are physical pixels.
/// </summary>
/// <param name="IsSingleColor">
/// True when every captured pixel has the same RGB value. PrintWindow can report success while the
/// application rendered nothing (an all-black or all-white surface), but a blank window can also be
/// the honest state of the app. The image is therefore kept and this fact is reported; the caller
/// decides whether a single-color frame is meaningful evidence.
/// </param>
/// <param name="SingleColorHex">The shared color as <c>#RRGGBB</c> when <paramref name="IsSingleColor"/> is true.</param>
public sealed record WindowsWindowCapture(
    string FilePath,
    long ByteCount,
    int PixelWidth,
    int PixelHeight,
    nint WindowHandle,
    int ProcessId,
    DateTimeOffset CapturedAt,
    bool IsSingleColor,
    string? SingleColorHex);

/// <summary>
/// Result of <see cref="WindowsWindowCapturer.CaptureProcessWindow"/>. Only <see cref="WindowsWindowCaptureOutcome.Captured"/>
/// carries <see cref="Capture"/>; every other outcome means this call wrote nothing there or removed what it
/// created (removal is best effort and never touches a file that existed before the call).
/// </summary>
public sealed record WindowsWindowCaptureResult(
    WindowsWindowCaptureOutcome Outcome,
    WindowsWindowCapture? Capture,
    string? Reason,
    int? Win32Error = null)
{
    public bool Succeeded => Outcome == WindowsWindowCaptureOutcome.Captured && Capture is not null;

    internal static WindowsWindowCaptureResult Captured(WindowsWindowCapture capture) =>
        new(WindowsWindowCaptureOutcome.Captured, capture, null);

    internal static WindowsWindowCaptureResult NoWindow(string reason) =>
        new(WindowsWindowCaptureOutcome.NoCapturableWindow, null, reason);

    internal static WindowsWindowCaptureResult Unavailable(string reason, int? win32Error = null) =>
        new(WindowsWindowCaptureOutcome.EnvironmentUnavailable, null, reason, win32Error);

    internal static WindowsWindowCaptureResult Failure(string reason, int? win32Error = null) =>
        new(WindowsWindowCaptureOutcome.Failed, null, reason, win32Error);

    internal static WindowsWindowCaptureResult Timeout(string reason) =>
        new(WindowsWindowCaptureOutcome.TimedOut, null, reason);
}

public sealed record WindowsWindowCaptureOptions
{
    public static readonly TimeSpan MaximumTimeout = TimeSpan.FromSeconds(60);

    /// <summary>Upper bound for the responsiveness probe, PrintWindow and PNG encoding together.</summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>Windows narrower than this (physical pixels) are not capturable.</summary>
    public int MinimumWidth { get; init; } = 40;

    /// <summary>Windows shorter than this (physical pixels) are not capturable.</summary>
    public int MinimumHeight { get; init; } = 40;

    /// <summary>
    /// When set, only this top-level window of the bound process may be captured; there is no fallback to
    /// another window if it is gone or not capturable.
    /// </summary>
    public nint? WindowHandle { get; init; }
}
