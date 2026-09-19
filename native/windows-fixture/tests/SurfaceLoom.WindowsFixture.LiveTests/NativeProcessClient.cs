using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace SurfaceLoom.WindowsFixture.LiveTests;

internal sealed class NativeProcessClient : IAsyncDisposable
{
    private readonly Process process;
    private readonly Task<string> diagnostics;
    private readonly CancellationTokenSource diagnosticsCancellation = new();
    private int requestCounter;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private NativeProcessClient(Process process)
    {
        this.process = process;
        diagnostics = ReadBoundedDiagnostics(process.StandardError, diagnosticsCancellation.Token);
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
        try
        {
            process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            string stderr;
            try
            {
                stderr = await diagnostics.WaitAsync(TimeSpan.FromSeconds(1));
            }
            catch (TimeoutException exception)
            {
                throw new InvalidOperationException(
                    "Native host exited but inherited stderr remained open; cleanup is unconfirmed.", exception);
            }
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    $"Native host exited with code {process.ExitCode}; cleanup is unconfirmed. {Safe(stderr)}");
            }
        }
        catch (TimeoutException exception)
        {
            throw new InvalidOperationException(
                "Native host did not exit after stdin closed; cleanup is unconfirmed.", exception);
        }
        finally
        {
            diagnosticsCancellation.Cancel();
            diagnosticsCancellation.Dispose();
            process.Dispose();
        }
    }

    private async Task<string> Diagnostics()
    {
        if (!process.HasExited)
        {
            return "Host is still running.";
        }
        try
        {
            return Safe(await diagnostics.WaitAsync(TimeSpan.FromMilliseconds(250)));
        }
        catch (TimeoutException)
        {
            return "Host exited but its bounded diagnostics pipe has not closed.";
        }
    }

    private static async Task<string> ReadBoundedDiagnostics(
        StreamReader reader,
        CancellationToken cancellationToken)
    {
        const int limit = 8192;
        var result = new StringBuilder(limit);
        var buffer = new char[1024];
        try
        {
            while (true)
            {
                var count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
                if (count == 0) return result.ToString();
                result.Append(buffer, 0, count);
                if (result.Length > limit) result.Remove(0, result.Length - limit);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return result.ToString();
        }
    }

    private static string Safe(string value)
    {
        var bounded = value.Trim();
        if (bounded.Length > 1024) bounded = bounded[^1024..];
        bounded = Regex.Replace(bounded, @"(?i)(token|secret|password)\s*[=:]\s*\S+", "$1=<redacted>");
        bounded = Regex.Replace(bounded, @"(?:[A-Za-z]:\\|/)[^\r\n""']+", "<path>");
        return bounded.Length == 0 ? "No native-host stderr." : bounded;
    }
}
