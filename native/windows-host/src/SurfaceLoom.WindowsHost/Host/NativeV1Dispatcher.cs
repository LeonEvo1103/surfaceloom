using System.Diagnostics;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Host;

public sealed class NativeV1Dispatcher : IDisposable
{
    private const int OperationRegistryLimit = 100_000;
    private readonly object stateGate = new();
    private readonly RequestDispatcher? legacy;
    private readonly Func<RpcRequest, object> dispatch;
    private readonly Dictionary<string, CancellationTokenSource> outstanding = new(StringComparer.Ordinal);
    private readonly Dictionary<string, SessionState> sessions = new(StringComparer.Ordinal);
    private readonly HashSet<string> usedOperationIds = new(StringComparer.Ordinal);
    private bool disposed;

    public NativeV1Dispatcher()
    {
        legacy = new RequestDispatcher();
        dispatch = legacy.Dispatch;
        HostInstanceId = $"windows-{Guid.NewGuid():N}";
    }

    internal NativeV1Dispatcher(Func<RpcRequest, object> dispatch)
    {
        this.dispatch = dispatch;
        HostInstanceId = $"windows-{Guid.NewGuid():N}";
    }

    public string HostInstanceId { get; }

    internal Action? BeforePrepareRegistrationForTests { get; set; }
    internal Action? PrepareRejectedAfterDisposeForTests { get; set; }

    internal bool IsDisposedForTests
    {
        get
        {
            lock (stateGate)
            {
                return disposed;
            }
        }
    }

    internal int OutstandingCountForTests
    {
        get
        {
            lock (stateGate)
            {
                return outstanding.Count;
            }
        }
    }

    internal bool IsOutstanding(string requestId)
    {
        lock (stateGate)
        {
            return outstanding.ContainsKey(requestId);
        }
    }

    public NativeV1PreparedRequest Prepare(string line, long receivedTimestamp, int delimiterBytes = 1)
    {
        using var document = NativeV1Parser.ParseFrame(line, delimiterBytes);
        var request = NativeV1Parser.ParseRequest(document.RootElement);
        return Prepare(request, receivedTimestamp);
    }

    internal NativeV1PreparedRequest Prepare(NativeV1Request request, long receivedTimestamp)
    {
        BeforePrepareRegistrationForTests?.Invoke();
        lock (stateGate)
        {
            if (disposed)
            {
                PrepareRejectedAfterDisposeForTests?.Invoke();
                throw new ObjectDisposedException(nameof(NativeV1Dispatcher));
            }
            var cancellation = new CancellationTokenSource();
            if (!outstanding.TryAdd(request.Id, cancellation))
            {
                cancellation.Dispose();
                throw new NativeV1ProtocolException(
                    "request_id_conflict", "conflict", "An outstanding request already uses this id.", request.Id);
            }
            return new NativeV1PreparedRequest(
                request,
                receivedTimestamp,
                ReleaseOutstanding,
                cancellation);
        }
    }

    public void Cancel(NativeV1Cancel cancel)
    {
        CancellationTokenSource? cancellation;
        lock (stateGate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            outstanding.TryGetValue(cancel.RequestId, out cancellation);
        }
        try
        {
            cancellation?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The original request won the race and already owns its terminal response.
        }
    }

    public NativeV1Response Execute(NativeV1PreparedRequest prepared)
    {
        try
        {
            return ExecuteOutbound(prepared).Response;
        }
        finally
        {
            prepared.Dispose();
        }
    }

    internal NativeV1OutboundFrame ExecuteOutbound(NativeV1PreparedRequest prepared)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var response = ExecuteCore(prepared);
        NativeV1OutboundFrame frame;
        try
        {
            frame = NativeV1OutboundSerializer.Serialize(response);
        }
        catch (Exception)
        {
            response = OutboundFailure(
                prepared.Request,
                response,
                "response_too_large",
                "internal",
                "The native response exceeded its bounded wire contract.");
            frame = NativeV1OutboundSerializer.Serialize(response);
        }

        if (prepared.RemainingMilliseconds() == 0 && response.Error?.Code != "deadline_exceeded")
        {
            response = OutboundFailure(
                prepared.Request,
                response,
                "deadline_exceeded",
                "deadline",
                "The response could not be constructed within its deadline.");
            frame = NativeV1OutboundSerializer.Serialize(response);
        }
        return frame;
    }

    private NativeV1Response ExecuteCore(NativeV1PreparedRequest prepared)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var request = prepared.Request;
        var sideEffecting = request.Call.Intent != "observe";
        var submitted = false;
        try
        {
            ValidateDispatchContract(request);
            RegisterOperationId(request);
            if (prepared.CancellationToken.IsCancellationRequested)
            {
                return Failure(request, "request_cancelled", "cancelled",
                    "The request was cancelled before native submission.", submitted: false);
            }
            var remainingMs = prepared.RemainingMilliseconds();
            if (remainingMs == 0)
            {
                return Failure(request, "deadline_exceeded", "deadline",
                    "The request deadline expired before native submission.", submitted: false);
            }

            var legacyRequest = NativeV1PayloadAdapter.BuildLegacyRequest(request, remainingMs);
            ValidatePayloadHandleReferences(request, legacyRequest);
            if (prepared.CancellationToken.IsCancellationRequested || prepared.RemainingMilliseconds() == 0)
            {
                return Failure(request, prepared.CancellationToken.IsCancellationRequested
                        ? "request_cancelled" : "deadline_exceeded",
                    prepared.CancellationToken.IsCancellationRequested ? "cancelled" : "deadline",
                    "The request stopped before native submission.", submitted: false);
            }

            object result;
            if (request.Call.Name == HostProtocol.Handshake)
            {
                result = CreateHostDescriptor();
            }
            else
            {
                submitted = sideEffecting;
                result = dispatch(legacyRequest);
                result = TransformResult(request, result);
            }

            if (prepared.RemainingMilliseconds() == 0)
            {
                return Failure(request, "deadline_exceeded", "deadline",
                    "The request exceeded its response deadline.", submitted, "executed");
            }
            return Success(request, result);
        }
        catch (NativeV1ProtocolException exception)
        {
            return Failure(request, exception.Code, exception.Category, exception.Message, submitted);
        }
        catch (HostOperationException exception)
        {
            return Failure(request, exception.Code, CategoryFor(exception.Code), SafeMessageFor(exception.Code), submitted);
        }
        catch (Exception)
        {
            return Failure(request, "host_internal_error", "internal",
                "The Windows native host failed unexpectedly.", submitted);
        }
    }

    public void Dispose()
    {
        CancellationTokenSource[] pending;
        lock (stateGate)
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            pending = outstanding.Values.ToArray();
            outstanding.Clear();
        }
        foreach (var cancellation in pending)
        {
            try
            {
                cancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // A completed request may be removing the same registration.
            }
        }
        legacy?.Dispose();
        foreach (var cancellation in pending)
        {
            cancellation.Dispose();
        }
        sessions.Clear();
        usedOperationIds.Clear();
    }

    private bool ReleaseOutstanding(string requestId, CancellationTokenSource cancellation)
    {
        lock (stateGate)
        {
            if (outstanding.TryGetValue(requestId, out var current) && ReferenceEquals(current, cancellation))
            {
                outstanding.Remove(requestId);
                return true;
            }
            return false;
        }
    }

    private void ValidateDispatchContract(NativeV1Request request)
    {
        if (!NativeV1Protocol.Methods.TryGetValue(request.Call.Name, out var method))
        {
            throw new NativeV1ProtocolException(
                "method_not_found", "unsupported", "The requested method is not advertised.", request.Id);
        }
        if (method.Intent != request.Call.Intent || !method.ScopeKinds.Contains(request.Call.Scope.Kind, StringComparer.Ordinal))
        {
            throw new NativeV1ProtocolException(
                "method_contract_mismatch", "invalidRequest",
                "The call intent or scope does not match the advertised method descriptor.", request.Id);
        }
        var scope = request.Call.Scope;
        if (scope.Kind != "bootstrap" && scope.HostInstanceId != HostInstanceId)
        {
            throw new NativeV1ProtocolException(
                "host_instance_stale", "conflict", "The call targets a stale host instance.", request.Id);
        }
        if (scope.Kind is "session" or "handle")
        {
            if (!sessions.TryGetValue(scope.SessionId!, out var session))
            {
                throw new NativeV1ProtocolException(
                    "session_not_found", "notFound", "The native session is not active.", request.Id);
            }
            if (scope.Kind == "handle" && !session.Handles.Contains(scope.HandleId!))
            {
                throw new NativeV1ProtocolException(
                    "element_handle_unknown", "notFound", "The handle does not belong to this session.", request.Id);
            }
            if (request.Call.Name is HostProtocol.CloseSession or HostProtocol.TerminateSession &&
                session.Ownership != "owned")
            {
                throw new NativeV1ProtocolException(
                    "ownership_required", "permissionDenied", "This lifecycle action requires an owned session.", request.Id);
            }
        }
    }

    private void RegisterOperationId(NativeV1Request request)
    {
        if (request.Call.Intent == "observe")
        {
            return;
        }
        if (usedOperationIds.Count >= OperationRegistryLimit)
        {
            throw new NativeV1ProtocolException(
                "operation_registry_full", "conflict", "The operation registry reached its safety limit.", request.Id);
        }
        if (!usedOperationIds.Add(request.Call.OperationId!))
        {
            throw new NativeV1ProtocolException(
                "operation_id_reused", "conflict", "The operation id was already consumed.", request.Id);
        }
    }

    private void ValidatePayloadHandleReferences(NativeV1Request request, RpcRequest legacyRequest)
    {
        if (request.Call.Name != HostProtocol.PerformAction)
        {
            return;
        }
        var action = legacyRequest.Parameters.Deserialize<ElementActionRequest>(JsonDefaults.Options)
            ?? throw new HostOperationException("invalid_request", "The action payload is invalid.");
        var state = sessions[request.Call.Scope.SessionId!];
        if (!state.Handles.Contains(action.ExpectedTarget!.RootElementId))
        {
            throw new HostOperationException(
                "element_handle_unknown", "The checked action root is not active in this session.");
        }
    }

    private NativeV1HostDescriptor CreateHostDescriptor() => new(
        HostInstanceId,
        "windows",
        "uia",
        NativeV1Protocol.Methods.Values.ToArray(),
        NativeV1Protocol.MaxMessageBytes);

    private object TransformResult(NativeV1Request request, object result)
    {
        if (result is HostDoctorReport doctor)
        {
            return doctor with { ProtocolVersion = NativeV1Protocol.Version };
        }
        if (result is HostCapabilities capabilities)
        {
            return capabilities with { ProtocolVersion = NativeV1Protocol.Version };
        }
        if (result is SessionResult session)
        {
            var ownership = session.Ownership == SessionOwnership.Owned ? "owned" : "borrowed";
            var surface = session.Surface == SessionSurface.Desktop ? "system" : "application";
            var state = new SessionState(ownership, [session.Root.ElementId]);
            sessions.Add(session.SessionId, state);
            return new NativeV1SessionDescriptor(
                HostInstanceId,
                session.SessionId,
                ownership,
                surface,
                Handle(session.SessionId, session.Root.ElementId));
        }
        if (request.Call.Name is HostProtocol.ReleaseSession or HostProtocol.CloseSession or HostProtocol.TerminateSession)
        {
            sessions.Remove(request.Call.Scope.SessionId!);
            return result;
        }
        if (result is ElementSnapshot element)
        {
            return Remember(request.Call.Scope.SessionId!, element);
        }
        if (result is IReadOnlyList<ElementSnapshot> elements)
        {
            return elements.Select(element => Remember(request.Call.Scope.SessionId!, element)).ToArray();
        }
        if (result is ElementBatchQueryResult batch)
        {
            return new NativeV1BatchResult(batch.Clauses.Select(clause => new NativeV1BatchClauseResult(
                clause.ClauseIndex,
                clause.Elements.Select(element => Remember(request.Call.Scope.SessionId!, element)).ToArray())).ToArray());
        }
        return result;
    }

    private NativeV1ElementResult Remember(string sessionId, ElementSnapshot snapshot)
    {
        sessions[sessionId].Handles.Add(snapshot.ElementId);
        return new NativeV1ElementResult(Handle(sessionId, snapshot.ElementId), snapshot);
    }

    private NativeV1Handle Handle(string sessionId, string handleId) =>
        new(HostInstanceId, sessionId, handleId);

    private static NativeV1Response Success(NativeV1Request request, object result) => new()
    {
        Id = request.Id,
        Ok = true,
        Result = result,
        Operation = request.Call.Intent == "observe" ? null : new NativeV1OperationReceipt(
            request.Call.OperationId!, "executed"),
    };

    private static NativeV1Response Failure(
        NativeV1Request request,
        string code,
        string category,
        string message,
        bool submitted,
        string? provenOutcome = null)
    {
        var operation = request.Call.Intent == "observe" ? null : new NativeV1OperationReceipt(
            request.Call.OperationId!, provenOutcome ?? (submitted ? "unknown" : "notExecuted"));
        var safeRetry = operation?.Outcome == "notExecuted" && code != "operation_id_reused";
        return new NativeV1Response
        {
            Id = request.Id,
            Ok = false,
            Error = new NativeV1Error(code, category, message, safeRetry ? "safe" : "never"),
            Operation = operation,
        };
    }

    private static NativeV1Response OutboundFailure(
        NativeV1Request request,
        NativeV1Response original,
        string code,
        string category,
        string message)
    {
        var safeRetry = original.Operation?.Outcome == "notExecuted" && original.Error?.Retry == "safe";
        return new NativeV1Response
        {
            Id = request.Id,
            Ok = false,
            Error = new NativeV1Error(code, category, message, safeRetry ? "safe" : "never"),
            Operation = original.Operation,
        };
    }

    private static string CategoryFor(string code) => code switch
    {
        "invalid_request" => "invalidRequest",
        "method_not_found" or "capability_unsupported" or "action_not_supported" => "unsupported",
        "session_not_found" or "element_handle_unknown" or "executable_not_found" => "notFound",
        "ownership_required" => "permissionDenied",
        "action_target_changed" or "target_already_running" => "conflict",
        _ => "backend",
    };

    private static string SafeMessageFor(string code) => code switch
    {
        "invalid_request" => "The method payload is invalid.",
        "method_not_found" => "The requested method is not advertised.",
        "capability_unsupported" => "The requested native capability is unsupported.",
        "session_not_found" => "The native session is not active.",
        "element_handle_unknown" => "The handle is not active in this session.",
        "ownership_required" => "This lifecycle action requires an owned session.",
        "action_target_changed" => "The checked target changed before completion could be proven.",
        "executable_not_found" => "The requested executable was not found.",
        _ => "The Windows backend could not prove a successful result.",
    };

    private sealed record SessionState(string Ownership, HashSet<string> Handles);
}
