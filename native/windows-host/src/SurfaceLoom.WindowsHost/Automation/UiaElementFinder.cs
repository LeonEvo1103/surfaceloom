using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

internal static class UiaElementFinder
{
    public static AutomationElement FindOne(
        AutomationElement root,
        UiaLocator locator,
        WaitOptions wait,
        int? restrictToProcessId)
    {
        ProtocolValidator.Validate(locator, allowEmpty: false);
        ProtocolValidator.Validate(wait);

        var scope = UiaLocatorCompiler.ResolveScope(locator.Scope);
        var condition = CompileCondition(locator, restrictToProcessId);
        var clock = Stopwatch.StartNew();
        while (true)
        {
            var matches = Query(root, scope, condition);
            if (locator.MatchIndex is int matchIndex && matches.Count > matchIndex)
            {
                return matches[matchIndex];
            }

            if (locator.MatchIndex is null && matches.Count == 1)
            {
                return matches[0];
            }

            if (locator.MatchIndex is null && matches.Count > 1)
            {
                throw new HostOperationException(
                    "element_ambiguous",
                    $"Locator matched {matches.Count} elements; refine it or set matchIndex.",
                    new { locator, matchCount = matches.Count });
            }

            if (clock.ElapsedMilliseconds >= wait.TimeoutMs)
            {
                throw new HostOperationException(
                    "element_not_found",
                    "No UIA element matched the locator before the timeout.",
                    new { locator, wait.TimeoutMs });
            }

            Thread.Sleep(wait.PollIntervalMs);
        }
    }

    public static IReadOnlyList<AutomationElement> FindAll(
        AutomationElement root,
        UiaLocator locator,
        WaitOptions wait,
        int? restrictToProcessId)
    {
        ProtocolValidator.ValidateFindAll(locator);
        ProtocolValidator.Validate(wait);

        var scope = UiaLocatorCompiler.ResolveScope(locator.Scope);
        var condition = CompileCondition(locator, restrictToProcessId);
        return UiaPollingSearch.FindAllUntilAvailable(
            () => Query(root, scope, condition),
            wait);
    }

    private static Condition CompileCondition(UiaLocator locator, int? restrictToProcessId)
    {
        var condition = UiaLocatorCompiler.Compile(locator);
        return restrictToProcessId is int processId
            ? new AndCondition(
                new PropertyCondition(AutomationElement.ProcessIdProperty, processId),
                condition)
            : condition;
    }

    private static IReadOnlyList<AutomationElement> Query(
        AutomationElement root,
        TreeScope scope,
        Condition condition)
    {
        try
        {
            var collection = root.FindAll(scope, condition);
            var matches = new AutomationElement[collection.Count];
            for (var index = 0; index < collection.Count; index++)
            {
                matches[index] = collection[index];
            }
            return matches;
        }
        catch (ElementNotAvailableException exception)
        {
            throw new HostOperationException(
                "root_stale",
                "The selected search root is no longer available; locate its owning surface again.",
                inner: exception);
        }
        catch (UnauthorizedAccessException exception)
        {
            throw new HostOperationException(
                "uia_access_denied",
                "The host cannot query the UIA tree across the current integrity boundary.",
                inner: exception);
        }
        catch (Exception exception) when (
            exception is InvalidOperationException or COMException or InvalidComObjectException)
        {
            throw new HostOperationException(
                "uia_query_failed",
                "The UIA provider failed while querying the selected search root.",
                new { exceptionType = exception.GetType().Name },
                exception);
        }
    }
}
