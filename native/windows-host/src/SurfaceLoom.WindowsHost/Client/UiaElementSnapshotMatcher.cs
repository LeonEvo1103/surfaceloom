using SurfaceLoom.WindowsHost.Protocol;
using SurfaceLoom.WindowsHost.Automation;

namespace SurfaceLoom.WindowsHost.Client;

/// <summary>
/// Matches the selector portion of a locator against one already captured UIA snapshot. Scope
/// cannot be reconstructed from a snapshot alone. Action clients use this after refreshing a
/// stable handle so RuntimeId reuse cannot silently retarget a side effect to a different node.
/// </summary>
public static class UiaElementSnapshotMatcher
{
    public static bool MatchesSelectors(UiaLocator locator, ElementSnapshot snapshot)
        =>
        UiaActionTargetGuard.MatchesSelectors(locator, snapshot);
}
