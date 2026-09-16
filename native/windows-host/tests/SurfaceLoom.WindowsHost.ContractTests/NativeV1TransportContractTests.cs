using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static class NativeV1TransportContractTests
{
    public static void OutboundFramesAreBoundedAndPreserveOutcome()
    {
        using var dispatcher = new NativeV1Dispatcher(request => request.Method switch
        {
            HostProtocol.LaunchSession => new SessionResult(
                "session-large", 42, SessionOwnership.Owned, SessionSurface.Window, Snapshot("root-large")),
            HostProtocol.PerformAction => Snapshot(
                "root-large",
                new string('x', NativeV1Protocol.MaxMessageBytes + 128)),
            _ => throw new InvalidOperationException("Unexpected method."),
        });
        var launch = dispatcher.Execute(dispatcher.Prepare(
            Launch(dispatcher, "large-launch", "operation-large-launch"), Stopwatch.GetTimestamp()));
        True(launch.Ok, "Injected launch must establish action scope.");

        using var prepared = dispatcher.Prepare(ActionRequest(dispatcher), Stopwatch.GetTimestamp());
        var outbound = dispatcher.ExecuteOutbound(prepared);
        True(outbound.WireBytes <= NativeV1Protocol.MaxMessageBytes,
            "Serialized response including LF must stay within the v1 byte limit.");
        Equal(outbound.WireBytes, Encoding.UTF8.GetByteCount(outbound.Line),
            "Recorded wire bytes must use UTF-8, not UTF-16 character count.");
        Equal("response_too_large", outbound.Response.Error?.Code,
            "Oversized backend results must become a bounded terminal failure.");
        Equal("executed", outbound.Response.Operation?.Outcome,
            "A bounded fallback must preserve a proven successful submission.");
        Equal("never", outbound.Response.Error?.Retry,
            "An executed action must remain non-retryable after response fallback.");
    }

    public static void CancellationWakesIdleInputAndReachesCleanup()
    {
        using var input = new BlockingUntilDisposedReader();
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();
        using var cancellation = new CancellationTokenSource();
        var run = Task.Run(() => new NdjsonHost(input, output, diagnostics).Run(cancellation.Token));
        True(input.ReadEntered.Wait(TimeSpan.FromSeconds(2)), "Reader must enter its idle blocking read.");

        cancellation.Cancel();
        True(run.Wait(TimeSpan.FromSeconds(2)), "Cancellation must wake the consumer despite idle stdin.");
        Equal(0, run.Result, "Cancellation shutdown must remain a clean host exit.");
        True(!input.WasDisposed, "Cancellation must not deadlock by disposing a synchronously locked reader.");
    }

    public static void PrepareCannotRegisterAfterHostDispose()
    {
        using var prepareEntered = new ManualResetEventSlim();
        using var releasePrepare = new ManualResetEventSlim();
        using var rejectedAfterDispose = new ManualResetEventSlim();
        var dispatcher = new NativeV1Dispatcher(_ => throw new InvalidOperationException("must not dispatch"))
        {
            BeforePrepareRegistrationForTests = () =>
            {
                prepareEntered.Set();
                releasePrepare.Wait();
            },
            PrepareRejectedAfterDisposeForTests = rejectedAfterDispose.Set,
        };
        var request = Launch(dispatcher, "prepare-race", "operation-prepare-race");
        using var input = new StringReader(request + "\n");
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();
        using var cancellation = new CancellationTokenSource();
        var run = Task.Run(() =>
            new NdjsonHost(input, output, diagnostics, dispatcher).Run(cancellation.Token));
        True(prepareEntered.Wait(TimeSpan.FromSeconds(2)),
            "Reader must stop inside the deterministic pre-registration window.");

        cancellation.Cancel();
        True(run.Wait(TimeSpan.FromSeconds(2)),
            "Host cancellation must return and dispose while Prepare remains blocked.");
        Equal(0, run.Result, "Prepare/Dispose race shutdown must remain clean.");
        True(dispatcher.IsDisposedForTests, "Host shutdown must dispose the native dispatcher.");
        Equal(0, dispatcher.OutstandingCountForTests,
            "Dispose must leave no request registration behind.");

        releasePrepare.Set();
        True(rejectedAfterDispose.Wait(TimeSpan.FromSeconds(2)),
            "Resumed Prepare must observe disposed state before registering a CTS.");
        Equal(0, dispatcher.OutstandingCountForTests,
            "A reader resumed after Dispose must not resurrect outstanding state.");
    }

    public static void OutstandingIdOwnsItsOnlyTerminalResponse()
    {
        var dispatcher = new NativeV1Dispatcher(_ => new SessionResult(
            "session-one", 42, SessionOwnership.Owned, SessionSurface.Window, Snapshot("root-one")));
        var first = Launch(dispatcher, "duplicate", "operation-original");
        var malformedDuplicate = JsonSerializer.Serialize(new
        {
            protocol = NativeV1Protocol.Name,
            version = NativeV1Protocol.Version,
            type = "request",
            id = "duplicate",
            unexpected = true,
        }, JsonDefaults.Options);
        using var input = new StringReader(first + "\n" + malformedDuplicate + "\n");
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();

        new NdjsonHost(input, output, diagnostics, dispatcher).Run(CancellationToken.None);
        var lines = output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Equal(1, lines.Length, "A malformed duplicate must not receive a second terminal response id.");
        using var response = JsonDocument.Parse(lines[0]);
        Equal("duplicate", response.RootElement.GetProperty("id").GetString(),
            "The original request must retain its terminal response.");
        True(response.RootElement.GetProperty("ok").GetBoolean(),
            "The duplicate frame must not replace the original result.");
        True(diagnostics.ToString().Contains("outstanding request", StringComparison.Ordinal),
            "The connection-level close must leave a safe diagnostic.");
    }

    public static void RoutingRequiresOneExactProtocolMarker()
    {
        NoResponse("{\"id\":\"missing\"}", "Missing markers must not be relabelled.");
        NoResponse(
            "{\"protocol\":\"surfaceloom.native\",\"protocolVersion\":\"0.2\",\"id\":\"conflict\"}",
            "Conflicting markers must not be relabelled.");
        NoResponse("{", "Invalid JSON before routing must not be relabelled.");
        NoResponse("{\"protocol\":\"vendor.native\",\"id\":\"vendor\"}",
            "Another shared protocol must not be treated as SurfaceLoom v1.");
        NoResponse("{\"protocolVersion\":\"0.1\",\"id\":\"old\"}",
            "Only exact legacy 0.2 may reach the legacy dispatcher.");

        var oversizedV1 = "{\"protocol\":\"surfaceloom.native\",\"padding\":\"" +
            new string('x', NativeV1Protocol.MaxMessageBytes) + "\"}";
        var oversizedLegacy = "{\"protocolVersion\":\"0.2\",\"padding\":\"" +
            new string('x', NativeV1Protocol.MaxMessageBytes) + "\"}";
        NoResponse(oversizedV1, "Oversized v1-looking input must fail before routing.");
        NoResponse(oversizedLegacy, "Oversized legacy-looking input must fail before routing.");

        var malformedV1 = RunOne(
            "{\"protocol\":\"surfaceloom.native\",\"version\":\"1.0\",\"id\":\"bad-v1\"}");
        using (var response = JsonDocument.Parse(malformedV1.Output))
        {
            Equal(NativeV1Protocol.Name, response.RootElement.GetProperty("protocol").GetString(),
                "A routed malformed v1 frame may only receive a v1 error.");
            True(!response.RootElement.TryGetProperty("protocolVersion", out _),
                "A malformed v1 frame must never become legacy.");
        }

        var malformedLegacy = RunOne("{\"protocolVersion\":\"0.2\",\"id\":\"bad-legacy\"}");
        using (var response = JsonDocument.Parse(malformedLegacy.Output))
        {
            Equal(HostProtocol.Version, response.RootElement.GetProperty("protocolVersion").GetString(),
                "A routed malformed legacy frame may only receive a 0.2 error.");
            True(!response.RootElement.TryGetProperty("protocol", out _),
                "A malformed legacy frame must never become v1.");
        }
    }

    private static void NoResponse(string frame, string message)
    {
        var result = RunOne(frame);
        Equal(string.Empty, result.Output, message);
        True(result.Diagnostics.Length > 0, "Connection-level rejection must emit a safe diagnostic.");
    }

    private static (string Output, string Diagnostics) RunOne(string frame)
    {
        using var input = new StringReader(frame);
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();
        new NdjsonHost(input, output, diagnostics).Run(CancellationToken.None);
        return (output.ToString(), diagnostics.ToString());
    }

    private static string Launch(NativeV1Dispatcher dispatcher, string id, string operationId) => Request(
        id,
        HostProtocol.LaunchSession,
        "lifecycle",
        new { kind = "host", hostInstanceId = dispatcher.HostInstanceId },
        new
        {
            executable = new { path = @"C:\fixture\SurfaceLoomFixture.exe", arguments = Array.Empty<string>() },
            waitForWindow = false,
        },
        operationId);

    private static string ActionRequest(NativeV1Dispatcher dispatcher) => Request(
        "large-action",
        HostProtocol.PerformAction,
        "mutate",
        new
        {
            kind = "handle",
            hostInstanceId = dispatcher.HostInstanceId,
            sessionId = "session-large",
            handleId = "root-large",
        },
        new
        {
            action = "invoke",
            expectedTarget = new
            {
                locator = new { automationIds = new[] { "root" } },
                processId = 42,
                rootElementId = "root-large",
            },
        },
        "operation-large-action");

    private static string Request(
        string id,
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
            deadline = new { timeoutMs = 10_000 },
            call,
        }, JsonDefaults.Options);
    }

    private static ElementSnapshot Snapshot(string id, string name = "root") => new(
        id, name, "root", "window", "Fixture", "WPF", 42, 1, true, false,
        null, false, null, null, null, null, null, null, [UiaAction.Invoke]);

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

    private sealed class BlockingUntilDisposedReader : TextReader
    {
        private readonly ManualResetEventSlim disposed = new();

        public ManualResetEventSlim ReadEntered { get; } = new();
        public bool WasDisposed { get; private set; }

        public override int Read()
        {
            ReadEntered.Set();
            disposed.Wait();
            return -1;
        }

        protected override void Dispose(bool disposing)
        {
            WasDisposed = true;
            disposed.Set();
            base.Dispose(disposing);
        }
    }
}
