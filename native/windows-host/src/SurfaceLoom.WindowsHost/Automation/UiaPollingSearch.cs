using System.Diagnostics;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

internal static class UiaPollingSearch
{
    public static IReadOnlyList<T> FindAllUntilAvailable<T>(
        Func<IReadOnlyList<T>> query,
        WaitOptions wait)
    {
        var clock = Stopwatch.StartNew();
        while (true)
        {
            var matches = query();
            if (matches.Count > 0)
            {
                return matches;
            }

            if (clock.ElapsedMilliseconds >= wait.TimeoutMs)
            {
                return Array.Empty<T>();
            }

            Thread.Sleep(wait.PollIntervalMs);
        }
    }
}
