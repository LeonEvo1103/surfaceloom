namespace SurfaceLoom.WindowsHost.Protocol;

public static class HostProtocol
{
    public const string Version = "0.2";

    public const string Handshake = "host.handshake";
    public const string RunDoctor = "host.doctor";
    public const string GetCapabilities = "capabilities.get";
    public const string LaunchSession = "session.launch";
    public const string AttachSession = "session.attach";
    public const string OpenDesktopSession = "session.desktop";
    public const string ReleaseSession = "session.release";
    public const string CloseSession = "session.close";
    public const string TerminateSession = "session.terminate";
    public const string FindElement = "element.find";
    public const string FindElements = "element.findAll";
    public const string QueryElementBatch = "element.queryBatch";
    public const string GetElement = "element.get";
    public const string PerformAction = "element.action";

    public static IReadOnlyList<string> Methods { get; } = Array.AsReadOnly(new[]
    {
        Handshake,
        RunDoctor,
        GetCapabilities,
        LaunchSession,
        AttachSession,
        OpenDesktopSession,
        ReleaseSession,
        CloseSession,
        TerminateSession,
        FindElement,
        FindElements,
        QueryElementBatch,
        GetElement,
        PerformAction,
    });
}
