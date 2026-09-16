using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public sealed partial class UiaSession : IDisposable
{
    internal const int ElementHandleLimit = 4_096;

    private readonly ElementHandleRegistry<AutomationElement> elements = new(ElementHandleLimit);
    private readonly int[] rootRuntimeId;
    private readonly OwnedProcessController? ownedProcess;
    private readonly bool restrictFindsToProcess;
    private bool disposed;

    private UiaSession(
        int processId,
        AutomationElement root,
        SessionOwnership ownership,
        SessionSurface surface,
        OwnedProcessController? ownedProcess = null,
        bool restrictFindsToProcess = false)
    {
        Id = Guid.NewGuid().ToString("N");
        ProcessId = processId;
        Root = root;
        rootRuntimeId = UiaElementIdentity.ReadRuntimeId(root);
        Ownership = ownership;
        Surface = surface;
        this.ownedProcess = ownedProcess;
        this.restrictFindsToProcess = restrictFindsToProcess;
    }

    public string Id { get; }
    public int ProcessId { get; }
    public AutomationElement Root { get; }
    public SessionOwnership Ownership { get; }
    public SessionSurface Surface { get; }

    public static UiaSession Attach(AttachSessionRequest request)
    {
        ProtocolValidator.Validate(request);
        DesktopAccessPolicy.ValidateDefaultInteractive(request.Desktop);
        ExistingProcessGuard.EnsureRunning(request.ProcessId);
        var window = UiaWindowFinder.WaitForProcessWindow(
            request.ProcessId,
            request.Window,
            request.Wait);
        return new UiaSession(
            request.ProcessId,
            window,
            SessionOwnership.External,
            SessionSurface.Window);
    }

    public static UiaSession Launch(LaunchSessionRequest request)
    {
        ProtocolValidator.Validate(request);
        DesktopAccessPolicy.ValidateDefaultInteractive(request.Desktop);
        var process = OwnedProcessController.Launch(request);
        try
        {
            if (request.WaitForWindow)
            {
                var window = UiaWindowFinder.WaitForProcessWindow(
                    process.ProcessId,
                    request.Window,
                    request.Wait,
                    () => process.HasExited);
                return new UiaSession(
                    process.ProcessId,
                    window,
                    SessionOwnership.Owned,
                    SessionSurface.Window,
                    process);
            }

            return new UiaSession(
                process.ProcessId,
                AutomationElement.RootElement,
                SessionOwnership.Owned,
                SessionSurface.Process,
                process,
                restrictFindsToProcess: true);
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    public static UiaSession OpenDesktop(DesktopSessionRequest request)
    {
        DesktopAccessPolicy.ValidateDefaultInteractive(request.Desktop);
        return new UiaSession(
            0,
            AutomationElement.RootElement,
            SessionOwnership.System,
            SessionSurface.Desktop);
    }

    public ProcessEndResult CloseGracefully(WaitOptions wait) =>
        RequireOwnedProcess("session.close").CloseGracefully(Id, wait);

    public ProcessEndResult Terminate(WaitOptions wait) =>
        RequireOwnedProcess("session.terminate").Terminate(Id, wait);

    public void EnsureCanRelease()
    {
        if (ownedProcess is not null && !ownedProcess.HasExited)
        {
            throw new HostOperationException(
                "owned_process_running",
                "Release would orphan a process launched by this host; use session.close or session.terminate first.");
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        elements.Clear();
        ownedProcess?.Dispose();
    }

    private int? RestrictedProcessId => restrictFindsToProcess ? ProcessId : null;

    private OwnedProcessController RequireOwnedProcess(string method) =>
        ownedProcess ?? throw new HostOperationException(
            "ownership_required",
            $"{method} is allowed only for a process launched and owned by this host.",
            new { Ownership, Surface });

    private void ThrowIfDisposed()
    {
        if (disposed)
        {
            throw new ObjectDisposedException(nameof(UiaSession));
        }
    }
}
