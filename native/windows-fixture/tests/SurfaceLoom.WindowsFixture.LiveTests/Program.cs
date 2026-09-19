using System.Text.Json;

namespace SurfaceLoom.WindowsFixture.LiveTests;

internal static class Program
{
    private static readonly string[] CaseNames =
    [
        "invoke exactly once",
        "set value and observe mirror",
        "strict ambiguity fails closed",
        "transient stable absence and recovery",
        "owned close exits process",
    ];

    public static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("Windows live conformance requires an interactive Windows session.");
            return 2;
        }
        if (args.Length != 3)
        {
            Console.Error.WriteLine("Usage: <host-exe> <fixture-exe> <report-json>");
            return 2;
        }

        var passed = new List<string>();
        string? failure = null;
        var session = new FixtureLiveSession(Path.GetFullPath(args[0]));
        try
        {
            await session.Start(Path.GetFullPath(args[1]));
            await Run(CaseNames[0], session.InvokeExactlyOnce, passed);
            await Run(CaseNames[1], session.SetValue, passed);
            await Run(CaseNames[2], session.RejectAmbiguity, passed);
            await Run(CaseNames[3], session.DismissAndRestoreTransient, passed);
            await Run(CaseNames[4], session.CloseOwnedProcess, passed);
        }
        catch (Exception exception)
        {
            failure = exception.ToString();
            var failedCase = passed.Count < CaseNames.Length
                ? CaseNames[passed.Count]
                : "live conformance teardown";
            Console.Error.WriteLine($"FAIL {failedCase}: {exception.Message}");
        }
        finally
        {
            try
            {
                await session.DisposeAsync();
            }
            catch (Exception exception)
            {
                failure = failure is null
                    ? $"Live conformance cleanup failed: {exception}"
                    : $"{failure}{Environment.NewLine}Live conformance cleanup also failed: {exception}";
                Console.Error.WriteLine($"FAIL live conformance cleanup: {exception.Message}");
            }
        }

        var reportPath = Path.GetFullPath(args[2]);
        Directory.CreateDirectory(Path.GetDirectoryName(reportPath)!);
        var failedCaseCount = failure is not null && passed.Count < CaseNames.Length ? 1 : 0;
        var report = new
        {
            schemaVersion = "surfaceloom.windows-live/1",
            generatedAt = DateTimeOffset.UtcNow,
            os = Environment.OSVersion.VersionString,
            hostRevision = Environment.GetEnvironmentVariable("SURFACELOOM_HOST_REVISION") ?? "working-tree",
            fixtureRevision = Environment.GetEnvironmentVariable("SURFACELOOM_FIXTURE_REVISION") ?? "working-tree",
            executedCaseCount = passed.Count + failedCaseCount,
            passedCaseCount = passed.Count,
            skippedCaseCount = CaseNames.Length - passed.Count - failedCaseCount,
            passedCases = passed,
            failure,
            cleanupConfirmed = session.CleanupConfirmed,
            cleanup = session.CleanupConfirmed
                ? "fixture session and native host exited without forced termination"
                : "unconfirmed",
        };
        await File.WriteAllTextAsync(reportPath, JsonSerializer.Serialize(report, new JsonSerializerOptions
        {
            WriteIndented = true,
        }));

        if (failure is not null || !session.CleanupConfirmed)
        {
            return 1;
        }
        Console.WriteLine($"{passed.Count}/{CaseNames.Length} Windows live conformance cases passed; 0 skipped.");
        Console.WriteLine($"Report: {reportPath}");
        return 0;
    }

    private static async Task Run(string name, Func<Task> test, List<string> passed)
    {
        await test();
        passed.Add(name);
        Console.WriteLine($"PASS {name}");
    }
}
