using System.Collections.ObjectModel;
using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public static class UiaActionExecutor
{
    public static IReadOnlyDictionary<UiaAction, string> PatternRequirements { get; } =
        new ReadOnlyDictionary<UiaAction, string>(new Dictionary<UiaAction, string>
        {
            [UiaAction.Invoke] = "InvokePattern",
            [UiaAction.SetValue] = "ValuePattern",
            [UiaAction.Toggle] = "TogglePattern",
            [UiaAction.Select] = "SelectionItemPattern",
            [UiaAction.Expand] = "ExpandCollapsePattern",
            [UiaAction.Collapse] = "ExpandCollapsePattern",
            [UiaAction.Focus] = "AutomationElement.SetFocus",
        });

    public static void Perform(AutomationElement element, ElementActionRequest request)
    {
        try
        {
            switch (request.Action)
            {
                case UiaAction.Invoke:
                    RequirePattern<InvokePattern>(element, InvokePattern.Pattern, request.Action).Invoke();
                    break;
                case UiaAction.SetValue:
                    SetValue(element, request.Value!);
                    break;
                case UiaAction.Toggle:
                    RequirePattern<TogglePattern>(element, TogglePattern.Pattern, request.Action).Toggle();
                    break;
                case UiaAction.Select:
                    RequirePattern<SelectionItemPattern>(element, SelectionItemPattern.Pattern, request.Action).Select();
                    break;
                case UiaAction.Expand:
                    RequirePattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern, request.Action).Expand();
                    break;
                case UiaAction.Collapse:
                    RequirePattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern, request.Action).Collapse();
                    break;
                case UiaAction.Focus:
                    element.SetFocus();
                    break;
                default:
                    throw new HostOperationException("action_not_supported", $"Unknown action {request.Action}.");
            }
        }
        catch (HostOperationException)
        {
            throw;
        }
        catch (ElementNotAvailableException exception)
        {
            throw new HostOperationException(
                "element_stale",
                "The UIA element is no longer available; locate it again.",
                inner: exception);
        }
        catch (ElementNotEnabledException exception)
        {
            throw new HostOperationException(
                "element_disabled",
                "The UIA element is disabled.",
                inner: exception);
        }
        catch (InvalidOperationException exception)
        {
            throw new HostOperationException(
                "action_failed",
                $"UIA action {request.Action} failed: {exception.Message}",
                inner: exception);
        }
    }

    public static IReadOnlyList<UiaAction> GetSupportedActions(AutomationElement element)
    {
        var actions = new List<UiaAction>();
        AddIfPattern(actions, element, InvokePattern.Pattern, UiaAction.Invoke);
        AddIfPattern(actions, element, ValuePattern.Pattern, UiaAction.SetValue);
        AddIfPattern(actions, element, TogglePattern.Pattern, UiaAction.Toggle);
        AddIfPattern(actions, element, SelectionItemPattern.Pattern, UiaAction.Select);

        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out _))
        {
            actions.Add(UiaAction.Expand);
            actions.Add(UiaAction.Collapse);
        }

        if (element.Current.IsKeyboardFocusable)
        {
            actions.Add(UiaAction.Focus);
        }

        return actions;
    }

    private static void SetValue(AutomationElement element, string value)
    {
        var pattern = RequirePattern<ValuePattern>(element, ValuePattern.Pattern, UiaAction.SetValue);
        if (pattern.Current.IsReadOnly)
        {
            throw new HostOperationException("element_read_only", "The UIA value is read-only.");
        }

        pattern.SetValue(value);
    }

    private static T RequirePattern<T>(
        AutomationElement element,
        AutomationPattern pattern,
        UiaAction action)
        where T : class
    {
        if (element.TryGetCurrentPattern(pattern, out var raw) && raw is T typed)
        {
            return typed;
        }

        throw new HostOperationException(
            "action_not_supported",
            $"Element does not expose {PatternRequirements[action]} required by {action}.",
            new { action, requiredPattern = PatternRequirements[action] });
    }

    private static void AddIfPattern(
        ICollection<UiaAction> actions,
        AutomationElement element,
        AutomationPattern pattern,
        UiaAction action)
    {
        if (element.TryGetCurrentPattern(pattern, out _))
        {
            actions.Add(action);
        }
    }
}
