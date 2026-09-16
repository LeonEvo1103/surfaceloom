using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Client;

/// <summary>
/// Plans an exact semantic action only when ExpandCollapse state proves which transition is safe.
/// Unknown and leaf-node states fail closed; Invoke is never treated as a guessed toggle.
/// </summary>
public static class UiaDisclosureActionPlanner
{
    public static bool IsProvenClosed(ElementSnapshot trigger)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        return string.Equals(
            trigger.ExpandCollapseState,
            "collapsed",
            StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsProvenOpen(ElementSnapshot trigger)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        return string.Equals(
                trigger.ExpandCollapseState,
                "expanded",
                StringComparison.OrdinalIgnoreCase) ||
            string.Equals(
                trigger.ExpandCollapseState,
                "partiallyExpanded",
                StringComparison.OrdinalIgnoreCase);
    }

    public static bool TryPlanOpen(ElementSnapshot trigger, out UiaAction action)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        action = default;
        if (!IsProvenClosed(trigger)) return false;
        if (trigger.SupportedActions.Contains(UiaAction.Expand))
        {
            action = UiaAction.Expand;
            return true;
        }
        return false;
    }

    public static bool TryPlanClose(ElementSnapshot trigger, out UiaAction action)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        action = default;
        if (!IsProvenOpen(trigger)) return false;
        if (trigger.SupportedActions.Contains(UiaAction.Collapse))
        {
            action = UiaAction.Collapse;
            return true;
        }
        return false;
    }
}
