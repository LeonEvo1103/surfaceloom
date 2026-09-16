using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>
/// Revalidates a remembered UIA target immediately before a semantic action. The host binds the
/// opaque handle back to its original RuntimeId, then checks the current process, every locator
/// selector, visibility, enabled state, and required pattern in the same dispatch as the action.
/// </summary>
public static class UiaActionTargetGuard
{
    public static void SubmitIfCurrent(
        ElementActionRequest request,
        ElementSnapshot current,
        IReadOnlyList<int> rememberedRuntimeId,
        IReadOnlyList<int> beforeSnapshotRuntimeId,
        IReadOnlyList<int> afterSnapshotRuntimeId,
        Action submit)
    {
        ArgumentNullException.ThrowIfNull(submit);
        RequireCurrent(
            request,
            current,
            rememberedRuntimeId,
            beforeSnapshotRuntimeId,
            afterSnapshotRuntimeId);
        submit();
    }

    public static void RequireCurrent(
        ElementActionRequest request,
        ElementSnapshot current,
        IReadOnlyList<int> rememberedRuntimeId,
        IReadOnlyList<int> beforeSnapshotRuntimeId,
        IReadOnlyList<int> afterSnapshotRuntimeId)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(rememberedRuntimeId);
        ArgumentNullException.ThrowIfNull(beforeSnapshotRuntimeId);
        ArgumentNullException.ThrowIfNull(afterSnapshotRuntimeId);
        var expected = request.ExpectedTarget ?? throw Changed(
            "The action target expectation was unavailable at the execution boundary.");
        if (!rememberedRuntimeId.SequenceEqual(beforeSnapshotRuntimeId) ||
            !rememberedRuntimeId.SequenceEqual(afterSnapshotRuntimeId) ||
            !string.Equals(request.ElementId, current.ElementId, StringComparison.Ordinal) ||
            current.ProcessId != expected.ProcessId)
        {
            throw Changed("The remembered UIA action target changed identity.");
        }
        if (!MatchesSelectors(expected.Locator, current))
        {
            throw Changed("The remembered UIA action target changed semantic selectors.");
        }
        if (current.IsOffscreen)
        {
            throw Changed("The remembered UIA action target became offscreen.");
        }
        if (!current.IsEnabled)
        {
            throw Changed("The remembered UIA action target became disabled.");
        }
        if (!current.SupportedActions.Contains(request.Action))
        {
            throw Changed("The remembered UIA action target lost its required pattern.");
        }
    }

    public static HostOperationException ChangedTarget(string message) => Changed(message);

    public static bool MatchesSelectors(UiaLocator locator, ElementSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(locator);
        ArgumentNullException.ThrowIfNull(snapshot);
        return locator.MatchIndex is null &&
            MatchesStringGroup(locator.AutomationIds, snapshot.AutomationId) &&
            MatchesStringGroup(locator.Names, snapshot.Name) &&
            MatchesControlTypeGroup(locator.ControlTypes, snapshot.ControlType) &&
            MatchesStringGroup(locator.ClassNames, snapshot.ClassName) &&
            MatchesStringGroup(locator.FrameworkIds, snapshot.FrameworkId) &&
            (locator.NativeWindowHandle is null ||
             locator.NativeWindowHandle.Value == snapshot.NativeWindowHandle);
    }

    private static bool MatchesStringGroup(IReadOnlyList<string> expected, string actual) =>
        expected.Count == 0 || expected.Contains(actual, StringComparer.Ordinal);

    private static bool MatchesControlTypeGroup(
        IReadOnlyList<string> expected,
        string actual) =>
        expected.Count == 0 || expected.Contains(actual, StringComparer.OrdinalIgnoreCase);

    private static HostOperationException Changed(string message) =>
        new("action_target_changed", message);
}
