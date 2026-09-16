using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public sealed class OwnedProcessController : IDisposable
{
    private readonly Process process;
    private bool disposed;

    private OwnedProcessController(Process process)
    {
        this.process = process;
    }

    public int ProcessId => process.Id;

    public bool HasExited
    {
        get
        {
            process.Refresh();
            return process.HasExited;
        }
    }

    public static OwnedProcessController Launch(LaunchSessionRequest request)
    {
        ProtocolValidator.Validate(request);
        var executablePath = Path.GetFullPath(request.ExecutablePath);
        if (!File.Exists(executablePath))
        {
            throw new HostOperationException(
                "executable_not_found",
                $"Executable '{executablePath}' does not exist.");
        }

        var workingDirectory = request.WorkingDirectory is null
            ? Path.GetDirectoryName(executablePath) ?? string.Empty
            : Path.GetFullPath(request.WorkingDirectory);
        if (!Directory.Exists(workingDirectory))
        {
            throw new HostOperationException(
                "working_directory_not_found",
                $"Working directory '{workingDirectory}' does not exist.");
        }

        RejectRunningTarget(executablePath);
        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
        };

        foreach (var argument in request.Arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        foreach (var variable in request.Environment)
        {
            startInfo.Environment[variable.Key] = variable.Value;
        }

        try
        {
            var process = Process.Start(startInfo) ?? throw new HostOperationException(
                "process_launch_failed",
                $"Windows did not return a process for '{executablePath}'.");
            return new OwnedProcessController(process);
        }
        catch (Exception exception) when (
            exception is Win32Exception or
            InvalidOperationException or
            FileNotFoundException or
            UnauthorizedAccessException)
        {
            throw new HostOperationException(
                "process_launch_failed",
                $"Failed to launch '{executablePath}': {exception.Message}",
                inner: exception);
        }
    }

    public ProcessEndResult CloseGracefully(string sessionId, WaitOptions wait)
    {
        ProtocolValidator.Validate(wait);
        if (HasExited)
        {
            return Result(sessionId, "close", wasAlreadyExited: true);
        }

        try
        {
            if (!process.CloseMainWindow())
            {
                throw new HostOperationException(
                    "graceful_close_unavailable",
                    "The owned process has no main window accepting WM_CLOSE; use an app quit component or session.terminate.");
            }

            if (!process.WaitForExit(wait.TimeoutMs))
            {
                throw new HostOperationException(
                    "graceful_close_timeout",
                    $"Owned process {ProcessId} did not exit after WM_CLOSE within {wait.TimeoutMs} ms.");
            }
        }
        catch (HostOperationException)
        {
            throw;
        }
        catch (InvalidOperationException) when (HasExited)
        {
            return Result(sessionId, "close", wasAlreadyExited: true);
        }
        catch (Exception exception) when (exception is InvalidOperationException or Win32Exception)
        {
            throw new HostOperationException(
                "graceful_close_failed",
                $"Could not request graceful close for owned process {ProcessId}: {exception.Message}",
                inner: exception);
        }

        return Result(sessionId, "close", wasAlreadyExited: false);
    }

    public ProcessEndResult Terminate(string sessionId, WaitOptions wait)
    {
        ProtocolValidator.Validate(wait);
        if (HasExited)
        {
            return Result(sessionId, "terminate", wasAlreadyExited: true);
        }

        try
        {
            process.Kill(entireProcessTree: true);
            if (!process.WaitForExit(wait.TimeoutMs))
            {
                throw new HostOperationException(
                    "terminate_timeout",
                    $"Owned process {ProcessId} did not terminate within {wait.TimeoutMs} ms.");
            }
        }
        catch (InvalidOperationException) when (HasExited)
        {
            return Result(sessionId, "terminate", wasAlreadyExited: true);
        }
        catch (Win32Exception exception)
        {
            throw new HostOperationException(
                "terminate_failed",
                $"Could not terminate owned process {ProcessId}: {exception.Message}",
                inner: exception);
        }

        return Result(sessionId, "terminate", wasAlreadyExited: false);
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5_000);
            }
        }
        catch (Exception exception) when (exception is InvalidOperationException or Win32Exception)
        {
            // Best-effort cleanup for a process this host owns; callers receive errors from explicit operations.
        }
        finally
        {
            process.Dispose();
        }
    }

    private ProcessEndResult Result(string sessionId, string action, bool wasAlreadyExited) =>
        new(sessionId, ProcessId, action, Exited: true, WasAlreadyExited: wasAlreadyExited);

    private static void RejectRunningTarget(string executablePath)
    {
        var processName = Path.GetFileNameWithoutExtension(executablePath);
        var matches = Process.GetProcessesByName(processName);
        try
        {
            if (matches.Length > 0)
            {
                throw new HostOperationException(
                    "target_already_running",
                    $"Refusing to launch '{executablePath}' while a same-name target is already running.",
                    new { processName, processIds = matches.Select(match => match.Id).ToArray() });
            }
        }
        finally
        {
            foreach (var match in matches)
            {
                match.Dispose();
            }
        }
    }
}
