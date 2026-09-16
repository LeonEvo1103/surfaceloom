using System.Diagnostics;
using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public static class UiaWindowFinder
{
    public static AutomationElement WaitForProcessWindow(
        int processId,
        UiaLocator? requestedLocator,
        WaitOptions wait,
        Func<bool>? hasExited = null)
    {
        var processCondition = new PropertyCondition(
            AutomationElement.ProcessIdProperty,
            processId);
        var locator = requestedLocator ?? new UiaLocator { ControlTypes = ["window"] };
        var locatorCondition = UiaLocatorCompiler.Compile(locator);
        var condition = new AndCondition(processCondition, locatorCondition);
        var clock = Stopwatch.StartNew();

        while (true)
        {
            if (hasExited?.Invoke() == true)
            {
                throw new HostOperationException(
                    "process_exited_before_window",
                    $"Process {processId} exited before exposing a matching top-level UIA window.");
            }

            var matches = AutomationElement.RootElement.FindAll(TreeScope.Children, condition);
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
                    "window_ambiguous",
                    $"Process {processId} has {matches.Count} matching top-level windows; refine the locator or set matchIndex.",
                    new { processId, locator, matchCount = matches.Count });
            }

            if (clock.ElapsedMilliseconds >= wait.TimeoutMs)
            {
                throw new HostOperationException(
                    "window_not_found",
                    $"No top-level UIA window was found for process {processId}.",
                    new { processId, locator, wait.TimeoutMs });
            }

            Thread.Sleep(wait.PollIntervalMs);
        }
    }
}
