using System.Diagnostics;
using System.IO;
using SurfaceLoom.WindowsHost.Automation;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static class WindowsProcessIdentityReaderContractTests
{
    public static void FailureClassificationIsFailClosed()
    {
        foreach (var error in new[] { 6, 87, 299, 1168 })
        {
            Require(
                WindowsProcessIdentityReader.ClassifyWin32Failure(error) ==
                    WindowsProcessIdentityReadFailure.ProcessUnavailable,
                "A reviewed vanished-or-volatile Win32 error was not retryable.");
        }
        foreach (var error in new[] { 0, 5, 1234 })
        {
            Require(
                WindowsProcessIdentityReader.ClassifyWin32Failure(error) ==
                    WindowsProcessIdentityReadFailure.IdentityUnverifiable,
                "Access denied or an unknown Win32 error must fail closed.");
        }
    }

    public static void CurrentProcessUsesLimitedHandleIdentity()
    {
        using var process = Process.GetCurrentProcess();
        var result = WindowsProcessIdentityReader.Read(process.Id);
        Require(result.Succeeded, "The current process identity was not readable.");
        var identity = result.Identity!;
        Require(identity.ProcessId == process.Id, "The process ID changed during identity read.");
        Require(
            string.Equals(
                Path.GetFullPath(identity.ExecutablePath),
                Path.GetFullPath(Environment.ProcessPath ?? string.Empty),
                StringComparison.OrdinalIgnoreCase),
            "The limited-query image path differs from the running executable.");
        Require(
            identity.StartTimeUtcTicks == process.StartTime.ToUniversalTime().Ticks,
            "Native process creation ticks differ from Process.StartTime.");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
