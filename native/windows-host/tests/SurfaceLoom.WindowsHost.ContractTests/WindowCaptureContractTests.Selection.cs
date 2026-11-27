using SurfaceLoom.WindowsHost.Automation;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static partial class WindowCaptureContractTests
{
    private const int Pid = 4242;

    public static void SelectionIsDeterministicAndProcessBound()
    {
        var windows = new[]
        {
            Window(0x10, pid: 7, zOrder: 0),
            Window(0x20, zOrder: 1, owner: 0x40),
            Window(0x30, zOrder: 3),
            Window(0x40, zOrder: 2),
        };
        var selected = WindowsWindowSelection.Select(windows, Pid, 40, 40);
        Equal((nint)0x40, selected.Window?.Handle ?? 0,
            "The frontmost unowned window of the bound process must win over other PIDs and owned popups.");
        Equal((nint)0x40, WindowsWindowSelection.Select(windows.Reverse().ToArray(), Pid, 40, 40).Window?.Handle ?? 0,
            "Selection must depend on z-order, not on list order.");

        var ownedOnly = WindowsWindowSelection.Select(
            [Window(0x50, zOrder: 1, owner: 0x99), Window(0x60, zOrder: 0, owner: 0x99)], Pid, 40, 40);
        Equal((nint)0x60, ownedOnly.Window?.Handle ?? 0,
            "Without an eligible unowned window, the frontmost eligible owned window must be used.");

        var preferred = WindowsWindowSelection.Select(windows, Pid, 40, 40, preferredHandle: 0x30);
        Equal((nint)0x30, preferred.Window?.Handle ?? 0, "An explicit bound window must be captured as requested.");

        var foreign = WindowsWindowSelection.Select(windows, Pid, 40, 40, preferredHandle: 0x10);
        True(foreign.Window is null && foreign.Reason!.Contains("not a top-level window of pid", StringComparison.Ordinal),
            "A preferred window of another process must never be captured.");
        True(WindowsWindowSelection.Select(windows, 0, 40, 40).Window is null,
            "An unbound process id must not select anything.");
    }

    public static void SelectionReportsWhyNothingIsCapturable()
    {
        AssertNoWindow([Window(0x10, minimized: true, width: 160, height: 28)], "1 minimized");
        AssertNoWindow([Window(0x10, cloaked: true)], "1 cloaked");
        AssertNoWindow([Window(0x10, visible: false)], "1 hidden");
        AssertNoWindow([Window(0x10, width: 39, height: 400)], "1 smaller than 40x40 px");
        AssertNoWindow([Window(0x10, pid: 7)], $"pid {Pid} has no top-level windows");
        AssertNoWindow(
            [Window(0x10, minimized: true), Window(0x20, cloaked: true, zOrder: 1), Window(0x30, minimized: true, zOrder: 2)],
            "1 cloaked, 2 minimized");

        var boundMinimized = WindowsWindowSelection.Select(
            [Window(0x10, minimized: true), Window(0x20, zOrder: 1)], Pid, 40, 40, preferredHandle: 0x10);
        True(boundMinimized.Window is null && boundMinimized.Reason!.EndsWith("is minimized", StringComparison.Ordinal),
            "A minimized bound window must be reported, not replaced by another window.");
    }

    private static void AssertNoWindow(WindowsWindowDescriptor[] windows, string expectedReason)
    {
        var result = WindowsWindowSelection.Select(windows, Pid, 40, 40);
        True(result.Window is null, $"No window should be selected for: {expectedReason}.");
        True(result.Reason?.Contains(expectedReason, StringComparison.Ordinal) == true,
            $"Reason must explain '{expectedReason}'; actual: {result.Reason}.");
    }

    private static WindowsWindowDescriptor Window(
        nint handle,
        int pid = Pid,
        int zOrder = 0,
        bool visible = true,
        bool cloaked = false,
        bool minimized = false,
        nint owner = 0,
        int width = 800,
        int height = 600) =>
        new(handle, pid, zOrder, visible, cloaked, minimized, owner, width, height);

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
}
