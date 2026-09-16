using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public static class UiaLocatorCompiler
{
    public static Condition Compile(UiaLocator locator)
    {
        var groups = new List<Condition>();

        AddStringGroup(groups, AutomationElement.AutomationIdProperty, locator.AutomationIds);
        AddStringGroup(groups, AutomationElement.NameProperty, locator.Names);
        AddStringGroup(groups, AutomationElement.ClassNameProperty, locator.ClassNames);
        AddStringGroup(groups, AutomationElement.FrameworkIdProperty, locator.FrameworkIds);

        if (locator.ControlTypes.Count > 0)
        {
            groups.Add(CombineOr(locator.ControlTypes
                .Select(name => (Condition)new PropertyCondition(
                    AutomationElement.ControlTypeProperty,
                    UiaControlTypeMap.Resolve(name)))
                .ToArray()));
        }

        if (locator.NativeWindowHandle is int handle)
        {
            groups.Add(new PropertyCondition(AutomationElement.NativeWindowHandleProperty, handle));
        }

        return groups.Count switch
        {
            0 => Condition.TrueCondition,
            1 => groups[0],
            _ => new AndCondition(groups.ToArray()),
        };
    }

    public static TreeScope ResolveScope(ElementSearchScope scope) => scope switch
    {
        ElementSearchScope.Element => TreeScope.Element,
        ElementSearchScope.Children => TreeScope.Children,
        ElementSearchScope.Descendants => TreeScope.Descendants,
        ElementSearchScope.Subtree => TreeScope.Subtree,
        _ => throw new ArgumentOutOfRangeException(nameof(scope), scope, null),
    };

    private static void AddStringGroup(
        ICollection<Condition> groups,
        AutomationProperty property,
        IReadOnlyList<string> values)
    {
        if (values.Count == 0)
        {
            return;
        }

        groups.Add(CombineOr(values
            .Select(value => (Condition)new PropertyCondition(property, value))
            .ToArray()));
    }

    private static Condition CombineOr(Condition[] conditions) =>
        conditions.Length == 1 ? conditions[0] : new OrCondition(conditions);
}
