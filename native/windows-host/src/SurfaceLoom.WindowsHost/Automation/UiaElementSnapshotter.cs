using System.Runtime.InteropServices;
using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public static class UiaElementSnapshotter
{
    // Native UIA property identifiers; the managed AutomationElement facade does not expose named fields.
    private const int AriaRolePropertyId = 30101;
    private const int AriaPropertiesPropertyId = 30102;

    public static ElementSnapshot Create(string elementId, AutomationElement element)
    {
        try
        {
            var current = element.Current;
            var value = ReadValue(element);
            return new ElementSnapshot(
                elementId,
                current.Name ?? string.Empty,
                current.AutomationId ?? string.Empty,
                UiaControlTypeMap.GetName(current.ControlType),
                current.ClassName ?? string.Empty,
                current.FrameworkId ?? string.Empty,
                current.ProcessId,
                current.NativeWindowHandle,
                current.IsEnabled,
                current.IsOffscreen,
                value.Value,
                current.HasKeyboardFocus,
                ReadSelection(element),
                ReadToggleState(element),
                ReadExpandCollapseState(element),
                ReadOptionalString(element, AutomationProperty.LookupById(AriaRolePropertyId), "ariaRole"),
                ReadOptionalString(
                    element,
                    AutomationProperty.LookupById(AriaPropertiesPropertyId),
                    "ariaProperties"),
                value.IsReadOnly,
                UiaActionExecutor.GetSupportedActions(element));
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
        catch (UnauthorizedAccessException exception)
        {
            throw new HostOperationException(
                "uia_access_denied",
                "The host cannot read the UIA element across the current integrity boundary.",
                new { elementId },
                exception);
        }
        catch (Exception exception) when (
            exception is InvalidOperationException or COMException or InvalidComObjectException)
        {
            throw new HostOperationException(
                "element_snapshot_failed",
                "The UIA provider failed while reading the element snapshot.",
                new { elementId, exceptionType = exception.GetType().Name },
                exception);
        }
    }

    private static (string? Value, bool? IsReadOnly) ReadValue(AutomationElement element)
    {
        var pattern = ReadPattern<ValuePattern>(element, ValuePattern.Pattern, "ValuePattern");
        if (pattern is null)
        {
            return (null, null);
        }

        var current = pattern.Current;
        return (current.Value ?? string.Empty, current.IsReadOnly);
    }

    private static bool? ReadSelection(AutomationElement element)
    {
        var pattern = ReadPattern<SelectionItemPattern>(
            element,
            SelectionItemPattern.Pattern,
            "SelectionItemPattern");
        if (pattern is null)
        {
            return null;
        }

        return pattern.Current.IsSelected;
    }

    private static string? ReadToggleState(AutomationElement element)
    {
        var pattern = ReadPattern<TogglePattern>(element, TogglePattern.Pattern, "TogglePattern");
        if (pattern is null)
        {
            return null;
        }

        return pattern.Current.ToggleState switch
        {
            ToggleState.Off => "off",
            ToggleState.On => "on",
            ToggleState.Indeterminate => "indeterminate",
            var state => throw UnsupportedState("toggleState", state),
        };
    }

    private static string? ReadExpandCollapseState(AutomationElement element)
    {
        var pattern = ReadPattern<ExpandCollapsePattern>(
            element,
            ExpandCollapsePattern.Pattern,
            "ExpandCollapsePattern");
        if (pattern is null)
        {
            return null;
        }

        return pattern.Current.ExpandCollapseState switch
        {
            ExpandCollapseState.Collapsed => "collapsed",
            ExpandCollapseState.Expanded => "expanded",
            ExpandCollapseState.PartiallyExpanded => "partiallyExpanded",
            ExpandCollapseState.LeafNode => "leafNode",
            var state => throw UnsupportedState("expandCollapseState", state),
        };
    }

    private static string? ReadOptionalString(
        AutomationElement element,
        AutomationProperty? property,
        string propertyName)
    {
        if (property is null)
        {
            return null;
        }

        var raw = element.GetCurrentPropertyValue(property, ignoreDefaultValue: true);
        if (ReferenceEquals(raw, AutomationElement.NotSupported))
        {
            return null;
        }

        return raw as string ?? throw new HostOperationException(
            "uia_property_type_mismatch",
            $"UIA property {propertyName} did not return a string.",
            new { property = propertyName, actualType = raw?.GetType().Name ?? "null" });
    }

    private static T? ReadPattern<T>(
        AutomationElement element,
        AutomationPattern pattern,
        string patternName)
        where T : class
    {
        if (!element.TryGetCurrentPattern(pattern, out var raw))
        {
            return null;
        }

        return raw as T ?? throw new HostOperationException(
            "uia_pattern_type_mismatch",
            $"UIA pattern {patternName} returned an unexpected object.",
            new { pattern = patternName, actualType = raw?.GetType().Name ?? "null" });
    }

    private static HostOperationException UnsupportedState(string property, object state) =>
        new(
            "uia_state_unsupported",
            $"UIA property {property} returned an unknown state.",
            new { property, state = state.ToString() });
}
