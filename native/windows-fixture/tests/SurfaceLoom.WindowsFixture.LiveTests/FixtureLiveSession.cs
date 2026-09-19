using System.Diagnostics;
using System.Text.Json;

namespace SurfaceLoom.WindowsFixture.LiveTests;

internal sealed class FixtureLiveSession : IAsyncDisposable
{
    private readonly NativeProcessClient client;
    private string hostInstanceId = string.Empty;
    private string sessionId = string.Empty;
    private string rootHandleId = string.Empty;
    private int processId;
    private bool released;

    public bool CleanupConfirmed { get; private set; }

    public FixtureLiveSession(string hostExecutable) => client = NativeProcessClient.Start(hostExecutable);

    public async Task Start(string fixtureExecutable)
    {
        var handshake = NativeProcessClient.RequireOk(await client.Call(
            "host.handshake", "observe", new { kind = "bootstrap" },
            new { client = "windows-fixture-live", supportedVersions = new[] { "1.0" } }), "handshake");
        hostInstanceId = handshake.GetProperty("hostInstanceId").GetString()
            ?? throw new InvalidOperationException("Handshake omitted hostInstanceId.");

        var launched = NativeProcessClient.RequireOk(await client.Call(
            "session.launch", "lifecycle", HostScope(), new
            {
                executable = new { path = fixtureExecutable, arguments = Array.Empty<string>() },
                workingDirectory = Path.GetDirectoryName(fixtureExecutable),
                environment = new { },
                desktop = "default",
                waitForWindow = true,
                window = Locator("surfaceloom.fixture.window.main", "window"),
                wait = new { timeoutMs = 10_000, pollIntervalMs = 50 },
            }, 15_000), "launch fixture");
        sessionId = launched.GetProperty("sessionId").GetString()
            ?? throw new InvalidOperationException("Launch omitted sessionId.");
        rootHandleId = launched.GetProperty("root").GetProperty("handleId").GetString()
            ?? throw new InvalidOperationException("Launch omitted root handle.");

        var ready = await Find("surfaceloom.fixture.lifecycle.state", "edit");
        processId = Snapshot(ready).GetProperty("processId").GetInt32();
        Equal("ready", Snapshot(ready).GetProperty("value").GetString(), "fixture ready state");
    }

    public async Task InvokeExactlyOnce()
    {
        var target = await Find("surfaceloom.fixture.invoke", "button");
        NativeProcessClient.RequireOk(await Action(target, "invoke"), "invoke once");
        var count = await Find("surfaceloom.fixture.invoke-count", "edit");
        Equal("1", Snapshot(count).GetProperty("value").GetString(), "invoke count");
    }

    public async Task SetValue()
    {
        const string value = "SurfaceLoom value ✓";
        var target = await Find("surfaceloom.fixture.value-input", "edit");
        NativeProcessClient.RequireOk(await Action(target, "setValue", value), "set value");
        var mirror = await Find("surfaceloom.fixture.value-mirror", "edit");
        Equal(value, Snapshot(mirror).GetProperty("value").GetString(), "value mirror");
    }

    public async Task RejectAmbiguity()
    {
        var locator = new
        {
            names = new[] { "Ambiguous action" },
            controlTypes = new[] { "button" },
            scope = "descendants",
        };
        var all = NativeProcessClient.RequireOk(await client.Call(
            "element.findAll", "observe", SessionScope(),
            new { locator, wait = new { timeoutMs = 1_000, pollIntervalMs = 50 } }), "find ambiguous controls");
        Equal(2, all.GetArrayLength(), "ambiguous candidate count");

        var strict = await client.Call("element.find", "observe", SessionScope(),
            new { locator, wait = new { timeoutMs = 1_000, pollIntervalMs = 50 } });
        if (strict.GetProperty("ok").GetBoolean() ||
            strict.GetProperty("error").GetProperty("code").GetString() != "element_ambiguous")
        {
            throw new InvalidOperationException("Strict ambiguity did not fail closed.");
        }
        var count = await Find("surfaceloom.fixture.ambiguous-count", "edit");
        Equal("0", Snapshot(count).GetProperty("value").GetString(), "ambiguous side effects");
    }

    public async Task DismissAndRestoreTransient()
    {
        var transient = await Find("surfaceloom.fixture.transient", "button");
        NativeProcessClient.RequireSubmitted(await Action(transient, "invoke"), "dismiss transient");
        for (var observation = 0; observation < 3; observation++)
        {
            var missing = NativeProcessClient.RequireOk(await FindAll(
                "surfaceloom.fixture.transient", "button", 300), "observe transient absence");
            Equal(0, missing.GetArrayLength(), $"transient absence observation {observation + 1}");
        }

        var restore = await Find("surfaceloom.fixture.transient-restore", "button");
        NativeProcessClient.RequireOk(await Action(restore, "invoke"), "restore transient");
        await Find("surfaceloom.fixture.transient", "button");
    }

    public async Task CloseOwnedProcess()
    {
        var close = await Find("surfaceloom.fixture.lifecycle.close", "button");
        NativeProcessClient.RequireSubmitted(await Action(close, "invoke"), "close fixture");
        var deadline = Stopwatch.StartNew();
        while (IsProcessRunning(processId) && deadline.Elapsed < TimeSpan.FromSeconds(10))
        {
            await Task.Delay(50);
        }
        if (IsProcessRunning(processId))
        {
            throw new InvalidOperationException("Owned fixture process did not exit after its close action.");
        }
        NativeProcessClient.RequireOk(await client.Call(
            "session.release", "lifecycle", SessionScope(), new { }), "release exited fixture");
        released = true;
    }

    public async ValueTask DisposeAsync()
    {
        Exception? cleanupFailure = null;
        if (!released && sessionId.Length > 0)
        {
            try
            {
                NativeProcessClient.RequireOk(await client.Call(
                    "session.terminate", "lifecycle", SessionScope(),
                    new { wait = new { timeoutMs = 5_000, pollIntervalMs = 50 } }),
                    "terminate fixture during cleanup");
            }
            catch (Exception exception)
            {
                cleanupFailure = exception;
            }
        }
        try
        {
            await client.DisposeAsync();
        }
        catch (Exception exception)
        {
            cleanupFailure = cleanupFailure is null
                ? exception
                : new AggregateException(cleanupFailure, exception);
        }
        if (cleanupFailure is not null)
        {
            throw new InvalidOperationException("Fixture or native host cleanup was not confirmed.", cleanupFailure);
        }
        CleanupConfirmed = true;
    }

    private Task<JsonElement> Find(string automationId, string controlType) => client.Call(
        "element.find", "observe", SessionScope(),
        new { locator = Locator(automationId, controlType), wait = new { timeoutMs = 3_000, pollIntervalMs = 50 } });

    private Task<JsonElement> FindAll(string automationId, string controlType, int timeoutMs) => client.Call(
        "element.findAll", "observe", SessionScope(),
        new { locator = Locator(automationId, controlType), wait = new { timeoutMs, pollIntervalMs = 50 } });

    private Task<JsonElement> Action(JsonElement target, string action, string? value = null)
    {
        var handle = target.GetProperty("result").GetProperty("handle");
        var snapshot = target.GetProperty("result").GetProperty("snapshot");
        var automationId = snapshot.GetProperty("automationId").GetString()!;
        var controlType = snapshot.GetProperty("controlType").GetString()!;
        return client.Call("element.action", "mutate", new
        {
            kind = "handle",
            hostInstanceId,
            sessionId,
            handleId = handle.GetProperty("handleId").GetString(),
        }, new
        {
            action,
            value,
            expectedTarget = new
            {
                locator = Locator(automationId, controlType),
                processId = snapshot.GetProperty("processId").GetInt32(),
                rootElementId = rootHandleId,
            },
        });
    }

    private object HostScope() => new { kind = "host", hostInstanceId };
    private object SessionScope() => new { kind = "session", hostInstanceId, sessionId };
    private static object Locator(string automationId, string controlType) => new
    {
        automationIds = new[] { automationId },
        controlTypes = new[] { controlType },
        scope = "descendants",
    };

    private static JsonElement Snapshot(JsonElement response) =>
        NativeProcessClient.RequireOk(response, "find element").GetProperty("snapshot");

    private static bool IsProcessRunning(int id)
    {
        try
        {
            using var process = Process.GetProcessById(id);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static void Equal<T>(T expected, T actual, string context)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{context}: expected {expected}, actual {actual}.");
        }
    }
}
