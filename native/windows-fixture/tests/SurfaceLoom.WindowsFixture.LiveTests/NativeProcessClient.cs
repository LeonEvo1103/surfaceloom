using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SurfaceLoom.WindowsFixture.LiveTests;

internal sealed class NativeProcessClient : IAsyncDisposable
{
    private readonly Process process;
    private readonly Task<string> diagnostics;
    private int requestCounter;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private NativeProcessClient(Process process)
    {
        this.process = process;
        diagnostics = process.StandardError.ReadToEndAsync();
    }

    public static NativeProcessClient Start(string hostExecutable)
    {
        var process = Process.Start(new ProcessStartInfo
        {
            FileName = hostExecutable,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        }) ?? throw new InvalidOperationException("The native host did not start.");
        return new NativeProcessClient(process);
    }

    public async Task<JsonElement> Call(
        string name,
        string intent,
        object scope,
        object payload,
        int timeoutMs = 10_000)
    {
        var requestId = $"live-{Interlocked.Increment(ref requestCounter)}";
        var request = new Dictionary<string, object?>
        {
            ["protocol"] = "surfaceloom.native",
            ["version"] = "1.0",
            ["type"] = "request",
            ["id"] = requestId,
            ["deadline"] = new { timeoutMs },
            ["call"] = new Dictionary<string, object?>
            {
                ["name"] = name,
                ["intent"] = intent,
                ["scope"] = scope,
                ["payload"] = payload,
                ["operationId"] = intent == "observe" ? null : $"operation-{Guid.NewGuid():N}",
            },
        };
        if (intent == "observe")
        {
            ((Dictionary<string, object?>)request["call"]!).Remove("operationId");
        }

        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(request, JsonOptions));
        await process.StandardInput.FlushAsync();
        var line = await process.StandardOutput.ReadLineAsync()
            .WaitAsync(TimeSpan.FromMilliseconds(timeoutMs + 2_000));
        if (line is null)
        {
            throw new InvalidOperationException(
                $"Native host disconnected before responding. {await Diagnostics()}");
        }

        using var document = JsonDocument.Parse(line);
        var response = document.RootElement.Clone();
        if (response.GetProperty("id").GetString() != requestId)
        {
            throw new InvalidOperationException("Native response correlation id changed.");
        }
        return response;
    }

    public static JsonElement RequireOk(JsonElement response, string context)
    {
        if (response.GetProperty("ok").GetBoolean())
        {
            return response.GetProperty("result");
        }
        var error = response.GetProperty("error");
        throw new InvalidOperationException(
            $"{context}: {error.GetProperty("code").GetString()} ({error.GetProperty("message").GetString()})");
    }

    public static void RequireSubmitted(JsonElement response, string context)
    {
        if (response.GetProperty("ok").GetBoolean())
        {
            return;
        }
        var outcome = response.GetProperty("operation").GetProperty("outcome").GetString();
        if (outcome is not ("executed" or "unknown"))
        {
            var code = response.GetProperty("error").GetProperty("code").GetString();
            throw new InvalidOperationException($"{context}: action was not submitted ({code}).");
        }
    }

    public async ValueTask DisposeAsync()
    {
        process.StandardInput.Close();
        if (!process.WaitForExit(3_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit(3_000);
        }
        await diagnostics;
        process.Dispose();
    }

    private async Task<string> Diagnostics()
    {
        if (!process.HasExited)
        {
            return "Host is still running.";
        }
        return (await diagnostics).Trim();
    }
}
