using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace SurfaceLoom.WindowsHost.Automation;

public enum WindowsProcessIdentityReadFailure
{
    None,
    ProcessUnavailable,
    IdentityUnverifiable,
}

public sealed record WindowsProcessImageIdentity(
    int ProcessId,
    string ExecutablePath,
    long StartTimeUtcTicks);

public sealed record WindowsProcessIdentityReadResult(
    WindowsProcessImageIdentity? Identity,
    WindowsProcessIdentityReadFailure Failure)
{
    public bool Succeeded => Identity is not null && Failure == WindowsProcessIdentityReadFailure.None;
}

/// <summary>
/// Reads a Windows process identity through one limited-query process handle. This avoids
/// Process.MainModule, which can require broader access than Electron sandbox helpers expose,
/// while keeping path and creation-time evidence bound to the same process object. Session
/// evidence is intentionally left to the caller because ProcessIdToSessionId is PID-based and
/// requires broader query rights on some sandboxed processes.
/// </summary>
public static class WindowsProcessIdentityReader
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int ErrorInvalidHandle = 6;
    private const int ErrorInvalidParameter = 87;
    private const int ErrorPartialCopy = 299;
    private const int ErrorNotFound = 1168;
    private const uint StillActive = 259;
    private const int MaximumWindowsPathCharacters = 32_768;

    public static WindowsProcessIdentityReadResult Read(int processId)
    {
        if (!OperatingSystem.IsWindows() || processId <= 0)
        {
            return Unverifiable();
        }

        using var process = OpenProcess(
            ProcessQueryLimitedInformation,
            inheritHandle: false,
            checked((uint)processId));
        if (process.IsInvalid)
        {
            return FromWin32Failure(Marshal.GetLastWin32Error());
        }

        var path = new StringBuilder(MaximumWindowsPathCharacters);
        var pathLength = checked((uint)path.Capacity);
        if (!QueryFullProcessImageName(process, 0, path, ref pathLength))
        {
            return FromWin32Failure(Marshal.GetLastWin32Error());
        }
        if (pathLength == 0 || pathLength >= path.Capacity)
        {
            return Unverifiable();
        }

        if (!GetProcessTimes(
                process,
                out var creationTime,
                out _,
                out _,
                out _))
        {
            return FromWin32Failure(Marshal.GetLastWin32Error());
        }
        if (!GetExitCodeProcess(process, out var exitCode))
        {
            return FromWin32Failure(Marshal.GetLastWin32Error());
        }
        if (exitCode != StillActive)
        {
            return new WindowsProcessIdentityReadResult(
                null,
                WindowsProcessIdentityReadFailure.ProcessUnavailable);
        }
        try
        {
            var executablePath = Path.GetFullPath(path.ToString());
            var startTimeUtcTicks = DateTime.FromFileTimeUtc(creationTime.ToInt64()).Ticks;
            if (string.IsNullOrWhiteSpace(executablePath) || startTimeUtcTicks <= 0)
            {
                return Unverifiable();
            }
            return new WindowsProcessIdentityReadResult(
                new WindowsProcessImageIdentity(
                    processId,
                    executablePath,
                    startTimeUtcTicks),
                WindowsProcessIdentityReadFailure.None);
        }
        catch (Exception exception) when (exception is
            ArgumentException or NotSupportedException or OverflowException)
        {
            return Unverifiable();
        }
    }

    internal static WindowsProcessIdentityReadFailure ClassifyWin32Failure(int error) =>
        error is ErrorInvalidHandle or ErrorInvalidParameter or ErrorPartialCopy or ErrorNotFound
            ? WindowsProcessIdentityReadFailure.ProcessUnavailable
            : WindowsProcessIdentityReadFailure.IdentityUnverifiable;

    private static WindowsProcessIdentityReadResult FromWin32Failure(int error) =>
        new(null, ClassifyWin32Failure(error));

    private static WindowsProcessIdentityReadResult Unverifiable() =>
        new(null, WindowsProcessIdentityReadFailure.IdentityUnverifiable);

    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(
        SafeProcessHandle process,
        uint flags,
        StringBuilder executableName,
        ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        SafeProcessHandle process,
        out FileTime creationTime,
        out FileTime exitTime,
        out FileTime kernelTime,
        out FileTime userTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(
        SafeProcessHandle process,
        out uint exitCode);

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct FileTime
    {
        private readonly uint lowDateTime;
        private readonly uint highDateTime;

        public long ToInt64() => unchecked((long)(
            ((ulong)highDateTime << 32) | lowDateTime));
    }
}
