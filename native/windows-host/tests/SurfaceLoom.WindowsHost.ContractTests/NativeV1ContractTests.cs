using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static class NativeV1ContractTests
{
    public static void HandshakeIsExactAndAdvertised()
    {
        var request = Request(
            "handshake-1",
            1_000,
            HostProtocol.Handshake,
            "observe",
            new { kind = "bootstrap" },
            new { client = "contract-tests", supportedVersions = new[] { "1.0" } });
        using var input = new StringReader(request + "\n");
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();

        Equal(0, new NdjsonHost(input, output, diagnostics).Run(CancellationToken.None),
            "Native v1 host must exit at EOF.");
        using var document = JsonDocument.Parse(output.ToString());
        var root = document.RootElement;
        Equal(NativeV1Protocol.Name, root.GetProperty("protocol").GetString(), "Protocol name must be exact.");
        Equal(NativeV1Protocol.Version, root.GetProperty("version").GetString(), "Protocol version must be exact.");
        True(root.GetProperty("ok").GetBoolean(), "Handshake must succeed.");
        var result = root.GetProperty("result");
        Equal("windows", result.GetProperty("platform").GetString(), "Handshake must identify Windows.");
        True(result.GetProperty("methods").EnumerateArray().Any(method =>
                method.GetProperty("name").GetString() == HostProtocol.PerformAction &&
                method.GetProperty("intent").GetString() == "mutate"),
            "Handshake must advertise the action intent.");
        Equal(string.Empty, diagnostics.ToString(), "A valid handshake must not write diagnostics.");
    }

    public static void DeadlineAndCancelStopBeforeSubmission()
    {
        var dispatchCount = 0;
        using var dispatcher = new NativeV1Dispatcher(_ =>
        {
            dispatchCount++;
            throw new InvalidOperationException("must not dispatch");
        });

        var expired = dispatcher.Prepare(LaunchRequest(dispatcher, "expired", "operation-expired", 0),
            Stopwatch.GetTimestamp());
        var expiredResponse = dispatcher.Execute(expired);
        Receipt(expiredResponse, "notExecuted", "safe");

        var cancelled = dispatcher.Prepare(LaunchRequest(dispatcher, "cancelled", "operation-cancelled", 10_000),
            Stopwatch.GetTimestamp());
        dispatcher.Cancel(ParseCancel("cancel-1", "cancelled"));
        var cancelledResponse = dispatcher.Execute(cancelled);
        Receipt(cancelledResponse, "notExecuted", "safe");
        Equal(0, dispatchCount, "Expired and pre-dispatch cancelled operations must not reach native dispatch.");
    }

    public static void PostSubmissionFailureIsUnknownAndNeverRetried()
    {
        var actionDispatches = 0;
        using var dispatcher = new NativeV1Dispatcher(request =>
        {
            if (request.Method == HostProtocol.LaunchSession)
            {
                return new SessionResult(
                    "session-1", 42, SessionOwnership.Owned, SessionSurface.Window, Snapshot("root-1"));
            }
            actionDispatches++;
            throw new HostOperationException(
                "action_target_changed",
                "This may also occur while capturing the post-action snapshot.");
        });
        var launch = dispatcher.Execute(dispatcher.Prepare(
            LaunchRequest(dispatcher, "launch", "operation-launch", 1_000), Stopwatch.GetTimestamp()));
        True(launch.Ok, "Injected launch must create tracked native state.");

        var action = Request(
            "action",
            1_000,
            HostProtocol.PerformAction,
            "mutate",
            new
            {
                kind = "handle",
                hostInstanceId = dispatcher.HostInstanceId,
                sessionId = "session-1",
                handleId = "root-1",
            },
            new
            {
                action = "invoke",
                expectedTarget = new
                {
                    locator = new { automationIds = new[] { "root" } },
                    processId = 42,
                    rootElementId = "root-1",
                },
            },
            "operation-action");
        var response = dispatcher.Execute(dispatcher.Prepare(action, Stopwatch.GetTimestamp()));
        Receipt(response, "unknown", "never");
        Equal(1, actionDispatches, "An unknown action outcome must never trigger host replay.");
    }

    public static void ReaderAcceptsCancelDuringDispatch()
    {
        using var dispatchEntered = new ManualResetEventSlim();
        using var cancelLineRead = new ManualResetEventSlim();
        var dispatcher = new NativeV1Dispatcher(_ =>
        {
            dispatchEntered.Set();
            if (!cancelLineRead.Wait(TimeSpan.FromSeconds(2)))
            {
                throw new InvalidOperationException("The input reader was blocked by dispatch.");
            }
            Thread.Sleep(20);
            throw new HostOperationException("backend_result_unavailable", "Completion is unknown.");
        });
        var request = LaunchRequest(dispatcher, "long-request", "operation-long", 10_000);
        var cancel = JsonSerializer.Serialize(new
        {
            protocol = NativeV1Protocol.Name,
            version = NativeV1Protocol.Version,
            type = "cancel",
            id = "cancel-long",
            requestId = "long-request",
            reason = "caller",
        }, JsonDefaults.Options);
        using var input = new TwoPhaseReader(request, cancel, dispatchEntered, cancelLineRead);
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();

        Equal(0, new NdjsonHost(input, output, diagnostics, dispatcher).Run(CancellationToken.None),
            "Host must finish after the concurrent cancel frame.");
        using var response = JsonDocument.Parse(output.ToString());
        Equal("unknown", response.RootElement.GetProperty("operation").GetProperty("outcome").GetString(),
            "Cancellation after dispatch entry cannot prove that the operation stopped.");
        Equal("never", response.RootElement.GetProperty("error").GetProperty("retry").GetString(),
            "An unknown cancelled operation must never be retried.");
    }

    public static void LateSuccessfulSideEffectProvesExecuted()
    {
        using var dispatcher = new NativeV1Dispatcher(_ =>
        {
            Thread.Sleep(20);
            return new SessionResult(
                "session-late", 42, SessionOwnership.Owned, SessionSurface.Window, Snapshot("root-late"));
        });
        var response = dispatcher.Execute(dispatcher.Prepare(
            LaunchRequest(dispatcher, "late", "operation-late", 5), Stopwatch.GetTimestamp()));
        True(!response.Ok, "A response constructed after the deadline must fail.");
        Equal("deadline_exceeded", response.Error?.Code, "Late completion must report its deadline.");
        Receipt(response, "executed", "never");
    }

    public static void ScopeAndOwnershipFailClosed()
    {
        var dispatches = 0;
        using var dispatcher = new NativeV1Dispatcher(request =>
        {
            dispatches++;
            if (request.Method == HostProtocol.OpenDesktopSession)
            {
                return new SessionResult(
                    "system-1", 0, SessionOwnership.System, SessionSurface.Desktop, Snapshot("desktop-root"));
            }
            throw new InvalidOperationException("must not dispatch");
        });
        var stale = Request(
            "stale",
            1_000,
            HostProtocol.LaunchSession,
            "lifecycle",
            new { kind = "host", hostInstanceId = "windows-stale" },
            LaunchPayload(),
            "operation-stale");
        var response = dispatcher.Execute(dispatcher.Prepare(stale, Stopwatch.GetTimestamp()));
        Equal("host_instance_stale", response.Error?.Code, "A stale host scope must be rejected.");
        Receipt(response, "notExecuted", "safe");

        var desktop = Request(
            "desktop",
            1_000,
            HostProtocol.OpenDesktopSession,
            "lifecycle",
            new { kind = "host", hostInstanceId = dispatcher.HostInstanceId },
            new { },
            "operation-desktop");
        var opened = dispatcher.Execute(dispatcher.Prepare(desktop, Stopwatch.GetTimestamp()));
        True(opened.Ok, "System session setup must succeed in the injected backend.");
        var close = Request(
            "close-borrowed",
            1_000,
            HostProtocol.CloseSession,
            "lifecycle",
            new { kind = "session", hostInstanceId = dispatcher.HostInstanceId, sessionId = "system-1" },
            new { },
            "operation-close-borrowed");
        var refused = dispatcher.Execute(dispatcher.Prepare(close, Stopwatch.GetTimestamp()));
        Equal("ownership_required", refused.Error?.Code, "Borrowed system sessions must not be closed.");
        Receipt(refused, "notExecuted", "safe");
        Equal(1, dispatches, "Ownership rejection must happen before lifecycle dispatch.");
    }

    public static void OperationIdsAreConsumedWithoutReplay()
    {
        using var dispatcher = new NativeV1Dispatcher(_ => throw new InvalidOperationException("must not dispatch"));
        var first = dispatcher.Execute(dispatcher.Prepare(
            LaunchRequest(dispatcher, "first", "operation-once", 0), Stopwatch.GetTimestamp()));
        Receipt(first, "notExecuted", "safe");
        var second = dispatcher.Execute(dispatcher.Prepare(
            LaunchRequest(dispatcher, "second", "operation-once", 0), Stopwatch.GetTimestamp()));
        Equal("operation_id_reused", second.Error?.Code, "A consumed operation id must not be dispatched again.");
        Receipt(second, "notExecuted", "never");
    }

    public static void FrameBoundaryCountsActualDelimiter()
    {
        const string baseJson = "{\"protocol\":\"surfaceloom.native\"}";
        var padding = new string(' ', NativeV1Protocol.MaxMessageBytes - Encoding.UTF8.GetByteCount(baseJson) - 1);
        using var accepted = NativeV1Parser.ParseFrame(baseJson + padding, delimiterBytes: 1);
        Equal(JsonValueKind.Object, accepted.RootElement.ValueKind, "LF-sized frame must fit exactly.");
        var exception = Throws<NativeV1ProtocolException>(() =>
            NativeV1Parser.ParseFrame(baseJson + padding, delimiterBytes: 2));
        Equal("message_too_large", exception.Code, "CRLF must count both delimiter bytes.");
    }

    public static void V1DoesNotRelabelLegacyFrames()
    {
        const string legacy = "{\"protocolVersion\":\"0.2\",\"id\":\"legacy\",\"method\":\"host.handshake\",\"params\":{}}";
        using var input = new StringReader(legacy);
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();
        new NdjsonHost(input, output, diagnostics).Run(CancellationToken.None);
        using var response = JsonDocument.Parse(output.ToString());
        Equal("0.2", response.RootElement.GetProperty("protocolVersion").GetString(),
            "Legacy responses must remain visibly 0.2.");
        True(!response.RootElement.TryGetProperty("protocol", out _),
            "A legacy response must not be relabelled as the shared protocol.");
    }

    private static NativeV1Cancel ParseCancel(string id, string requestId)
    {
        var json = JsonSerializer.Serialize(new
        {
            protocol = NativeV1Protocol.Name,
            version = NativeV1Protocol.Version,
            type = "cancel",
            id,
            requestId,
            reason = "caller",
        }, JsonDefaults.Options);
        using var document = NativeV1Parser.ParseFrame(json);
        return NativeV1Parser.ParseCancel(document.RootElement);
    }

    private static string LaunchRequest(
        NativeV1Dispatcher dispatcher,
        string id,
        string operationId,
        int timeoutMs) => Request(
            id,
            timeoutMs,
            HostProtocol.LaunchSession,
            "lifecycle",
            new { kind = "host", hostInstanceId = dispatcher.HostInstanceId },
            LaunchPayload(),
            operationId);

    private static object LaunchPayload() => new
    {
        executable = new { path = @"C:\fixture\SurfaceLoomFixture.exe", arguments = Array.Empty<string>() },
        waitForWindow = false,
    };

    private static string Request(
        string id,
        int timeoutMs,
        string method,
        string intent,
        object scope,
        object payload,
        string? operationId = null)
    {
        var call = new Dictionary<string, object?>
        {
            ["name"] = method,
            ["intent"] = intent,
            ["scope"] = scope,
            ["payload"] = payload,
        };
        if (operationId is not null)
        {
            call["operationId"] = operationId;
        }
        return JsonSerializer.Serialize(new
        {
            protocol = NativeV1Protocol.Name,
            version = NativeV1Protocol.Version,
            type = "request",
            id,
            deadline = new { timeoutMs },
            call,
        }, JsonDefaults.Options);
    }

    private static ElementSnapshot Snapshot(string id) => new(
        id, "root", "root", "window", "Fixture", "WPF", 42, 1, true, false,
        null, false, null, null, null, null, null, null, [UiaAction.Invoke]);

    private static void Receipt(NativeV1Response response, string outcome, string retry)
    {
        Equal(outcome, response.Operation?.Outcome, "Operation outcome must preserve the submission boundary.");
        Equal(retry, response.Error?.Retry, "Retry disposition must follow the operation outcome.");
    }

    private static T Throws<T>(Action action)
        where T : Exception
    {
        try
        {
            action();
        }
        catch (T exception)
        {
            return exception;
        }
        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }

    private static void True(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{message} Expected: {expected}; actual: {actual}.");
        }
    }

    private sealed class TwoPhaseReader : TextReader
    {
        private readonly string text;
        private readonly int secondPhase;
        private readonly ManualResetEventSlim dispatchEntered;
        private readonly ManualResetEventSlim cancelLineRead;
        private int index;

        public TwoPhaseReader(
            string request,
            string cancel,
            ManualResetEventSlim dispatchEntered,
            ManualResetEventSlim cancelLineRead)
        {
            text = request + "\n" + cancel + "\n";
            secondPhase = request.Length + 1;
            this.dispatchEntered = dispatchEntered;
            this.cancelLineRead = cancelLineRead;
        }

        public override int Read()
        {
            if (index == secondPhase && !dispatchEntered.Wait(TimeSpan.FromSeconds(2)))
            {
                throw new InvalidOperationException("Dispatch did not start before the cancel phase.");
            }
            if (index >= text.Length)
            {
                return -1;
            }
            var value = text[index++];
            if (index == text.Length)
            {
                cancelLineRead.Set();
            }
            return value;
        }
    }
}
