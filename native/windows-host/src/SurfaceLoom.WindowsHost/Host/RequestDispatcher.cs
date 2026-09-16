using System.Text.Json;
using SurfaceLoom.WindowsHost.Automation;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Host;

public sealed class RequestDispatcher : IDisposable
{
    private readonly Dictionary<string, UiaSession> sessions = new(StringComparer.Ordinal);
    private bool disposed;

    public object Dispatch(RpcRequest request)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        ProtocolValidator.ValidateRequest(request);

        return request.Method switch
        {
            HostProtocol.Handshake => CreateHandshake(),
            HostProtocol.RunDoctor => WindowsHostDoctor.Run(),
            HostProtocol.GetCapabilities => CapabilityCatalog.Create(),
            HostProtocol.LaunchSession => Launch(ReadParameters<LaunchSessionRequest>(request)),
            HostProtocol.AttachSession => Attach(ReadParameters<AttachSessionRequest>(request)),
            HostProtocol.OpenDesktopSession => OpenDesktop(ReadParameters<DesktopSessionRequest>(request)),
            HostProtocol.ReleaseSession => Release(ReadParameters<SessionRequest>(request)),
            HostProtocol.CloseSession => Close(ReadParameters<ProcessEndRequest>(request)),
            HostProtocol.TerminateSession => Terminate(ReadParameters<ProcessEndRequest>(request)),
            HostProtocol.FindElement => Find(ReadParameters<FindElementRequest>(request)),
            HostProtocol.FindElements => FindAll(ReadParameters<FindElementRequest>(request)),
            HostProtocol.QueryElementBatch => QueryBatch(
                ReadParameters<ElementBatchQueryRequest>(request)),
            HostProtocol.GetElement => Get(ReadParameters<ElementRequest>(request)),
            HostProtocol.PerformAction => Act(ReadParameters<ElementActionRequest>(request)),
            _ => throw new HostOperationException(
                "method_not_found",
                $"Unknown protocol method '{request.Method}'.",
                new { supported = HostProtocol.Methods }),
        };
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        foreach (var session in sessions.Values)
        {
            session.Dispose();
        }

        sessions.Clear();
    }

    private static HandshakeResult CreateHandshake() => new(
        ProtocolVersion: HostProtocol.Version,
        HostName: "SurfaceLoom.WindowsHost",
        Platform: "windows",
        ProcessId: Environment.ProcessId,
        Methods: HostProtocol.Methods);

    private SessionResult Launch(LaunchSessionRequest request) => Register(UiaSession.Launch(request));

    private SessionResult Attach(AttachSessionRequest request) => Register(UiaSession.Attach(request));

    private SessionResult OpenDesktop(DesktopSessionRequest request) =>
        Register(UiaSession.OpenDesktop(request));

    private SessionResult Register(UiaSession session)
    {
        try
        {
            var root = session.RememberRoot();
            sessions.Add(session.Id, session);
            return new SessionResult(
                session.Id,
                session.ProcessId,
                session.Ownership,
                session.Surface,
                root);
        }
        catch
        {
            session.Dispose();
            throw;
        }
    }

    private object Release(SessionRequest request)
    {
        ProtocolValidator.Validate(request);
        var session = GetSession(request.SessionId);
        session.EnsureCanRelease();
        sessions.Remove(request.SessionId);
        session.Dispose();
        return new { released = true, sessionId = request.SessionId };
    }

    private ProcessEndResult Close(ProcessEndRequest request)
    {
        ProtocolValidator.Validate(request);
        var session = GetSession(request.SessionId);
        var result = session.CloseGracefully(request.Wait);
        RemoveAndDispose(session);
        return result;
    }

    private ProcessEndResult Terminate(ProcessEndRequest request)
    {
        ProtocolValidator.Validate(request);
        var session = GetSession(request.SessionId);
        var result = session.Terminate(request.Wait);
        RemoveAndDispose(session);
        return result;
    }

    private ElementSnapshot Find(FindElementRequest request)
    {
        ProtocolValidator.Validate(request);
        return GetSession(request.SessionId).Find(
            request.Locator,
            request.Wait,
            request.RootElementId);
    }

    private IReadOnlyList<ElementSnapshot> FindAll(FindElementRequest request)
    {
        ProtocolValidator.ValidateFindAll(request);
        return GetSession(request.SessionId).FindAll(
            request.Locator,
            request.Wait,
            request.RootElementId);
    }

    private ElementBatchQueryResult QueryBatch(ElementBatchQueryRequest request)
    {
        ProtocolValidator.Validate(request);
        return GetSession(request.SessionId).QueryBatch(
            request.Clauses,
            request.RootElementId);
    }

    private ElementSnapshot Get(ElementRequest request)
    {
        ProtocolValidator.Validate(request);
        return GetSession(request.SessionId).Snapshot(request.ElementId);
    }

    private ElementSnapshot Act(ElementActionRequest request)
    {
        ProtocolValidator.Validate(request);
        return GetSession(request.SessionId).PerformCheckedAction(request);
    }

    private UiaSession GetSession(string sessionId)
    {
        if (sessions.TryGetValue(sessionId, out var session))
        {
            return session;
        }

        throw new HostOperationException(
            "session_not_found",
            $"Session '{sessionId}' is not active.");
    }

    private void RemoveAndDispose(UiaSession session)
    {
        sessions.Remove(session.Id);
        session.Dispose();
    }

    private static T ReadParameters<T>(RpcRequest request)
        where T : class
    {
        try
        {
            var value = request.Parameters.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null
                ? JsonSerializer.Deserialize<T>("{}", JsonDefaults.Options)
                : request.Parameters.Deserialize<T>(JsonDefaults.Options);
            return value ?? throw new HostOperationException(
                "invalid_request",
                $"Method '{request.Method}' requires a params object.");
        }
        catch (JsonException exception)
        {
            throw new HostOperationException(
                "invalid_request",
                $"Invalid params for method '{request.Method}': {exception.Message}",
                inner: exception);
        }
    }
}
