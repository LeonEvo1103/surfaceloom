using System.Diagnostics;
using SurfaceLoom.WindowsHost.Host;

namespace SurfaceLoom.WindowsHost.Automation;

public static class ExistingProcessGuard
{
    public static void EnsureRunning(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            if (process.HasExited)
            {
                throw new ArgumentException("Process already exited.");
            }
        }
        catch (ArgumentException exception)
        {
            throw new HostOperationException(
                "process_not_found",
                $"Process {processId} is not running.",
                inner: exception);
        }
    }
}
