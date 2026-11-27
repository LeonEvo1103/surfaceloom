using System.Globalization;

namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>
/// Snapshot of one top-level window. <see cref="ZOrder"/> is the enumeration index (0 = frontmost);
/// sizes are physical pixels of the window rectangle.
/// </summary>
internal sealed record WindowsWindowDescriptor(
    nint Handle,
    int ProcessId,
    int ZOrder,
    bool IsVisible,
    bool IsCloaked,
    bool IsMinimized,
    nint OwnerHandle,
    int Width,
    int Height);

internal sealed record WindowsWindowSelectionResult(WindowsWindowDescriptor? Window, string? Reason);

internal static class WindowsWindowSelection
{
    /// <summary>
    /// Pure, deterministic capture-target selection for one process.
    /// <list type="number">
    /// <item>Only windows of <paramref name="processId"/> that are visible, not DWM-cloaked, not minimized
    /// and at least the minimum size are eligible. A minimized window is never restored or captured.</item>
    /// <item>An explicit <paramref name="preferredHandle"/> is captured or reported, never substituted.</item>
    /// <item>Otherwise the frontmost (lowest <see cref="WindowsWindowDescriptor.ZOrder"/>) eligible unowned
    /// window wins: unowned top-level windows are application main windows, while owned ones include
    /// tooltips, popups and transient helpers. If no unowned window is eligible, the frontmost eligible
    /// owned window is used so an app showing only a dialog still yields evidence. Ties are impossible
    /// because z-order is a total order within one snapshot; handle value breaks malformed ties.</item>
    /// </list>
    /// </summary>
    public static WindowsWindowSelectionResult Select(
        IReadOnlyList<WindowsWindowDescriptor> windows,
        int processId,
        int minimumWidth,
        int minimumHeight,
        nint? preferredHandle = null)
    {
        ArgumentNullException.ThrowIfNull(windows);
        if (processId <= 0)
        {
            return new(null, "no bound application process");
        }

        var minWidth = Math.Max(minimumWidth, 1);
        var minHeight = Math.Max(minimumHeight, 1);
        var processWindows = windows
            .Where(window => window.ProcessId == processId)
            .OrderBy(window => window.ZOrder)
            .ThenBy(window => (long)window.Handle)
            .ToArray();

        if (preferredHandle is nint preferred)
        {
            // HWNDs carry 32 significant bits (UIA reports them as int), so compare only those bits.
            var bound = processWindows.FirstOrDefault(window =>
                unchecked((int)(long)window.Handle) == unchecked((int)(long)preferred));
            if (bound is null)
            {
                return new(null, $"window {Hex(preferred)} is not a top-level window of pid {processId}");
            }
            var problem = Ineligibility(bound, minWidth, minHeight);
            return problem is null
                ? new(bound, null)
                : new(null, $"window {Hex(preferred)} of pid {processId} is {problem}");
        }

        var eligible = processWindows.Where(window => Ineligibility(window, minWidth, minHeight) is null).ToArray();
        var selected = eligible.FirstOrDefault(window => window.OwnerHandle == 0) ?? eligible.FirstOrDefault();
        if (selected is not null)
        {
            return new(selected, null);
        }

        if (processWindows.Length == 0)
        {
            return new(null, $"pid {processId} has no top-level windows");
        }

        var summary = processWindows
            .GroupBy(window => Ineligibility(window, minWidth, minHeight)!, StringComparer.Ordinal)
            .OrderBy(group => group.Key, StringComparer.Ordinal)
            .Select(group => $"{group.Count()} {group.Key}");
        return new(null,
            $"none of the {processWindows.Length} top-level windows of pid {processId} is capturable: {string.Join(", ", summary)}");
    }

    /// <summary>Returns null when capturable, otherwise the first reason in a fixed precedence order.</summary>
    internal static string? Ineligibility(WindowsWindowDescriptor window, int minimumWidth, int minimumHeight)
    {
        if (!window.IsVisible) return "hidden";
        if (window.IsMinimized) return "minimized";
        if (window.IsCloaked) return "cloaked";
        if (window.Width < minimumWidth || window.Height < minimumHeight)
        {
            return string.Create(CultureInfo.InvariantCulture, $"smaller than {minimumWidth}x{minimumHeight} px");
        }
        return null;
    }

    internal static string Hex(nint handle) =>
        "0x" + ((long)handle).ToString("X", CultureInfo.InvariantCulture);
}
