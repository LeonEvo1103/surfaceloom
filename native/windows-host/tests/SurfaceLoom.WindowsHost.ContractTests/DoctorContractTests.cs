using System.IO;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static class DoctorContractTests
{
    public static void ReportBoundaries()
    {
        var report = WindowsHostDoctor.Run();
        Equal(4, Enum.GetValues<DoctorStatus>().Distinct().Count(),
            "Doctor must distinguish pass, warn, fail, and unsupported states.");
        Equal("1", report.SchemaVersion, "Doctor schema must be versioned independently.");
        Equal(HostProtocol.Version, report.ProtocolVersion,
            "Doctor must identify the active host protocol.");
        Equal("windows", report.Platform, "Doctor must identify its platform.");
        True(report.ReadOnly, "Doctor must promise read-only operation.");

        var checks = report.Checks.ToDictionary(check => check.Id, StringComparer.Ordinal);
        foreach (var id in ExpectedCheckIds())
        {
            True(checks.ContainsKey(id), $"Doctor is missing required check '{id}'.");
        }

        Equal(DoctorStatus.Warn, checks[WindowsHostDoctor.IntegrityBoundaryCheck].Status,
            "Unprobed target integrity must be a warning, not a false pass.");
        True(checks[WindowsHostDoctor.OsCheck].Required,
            "OS, session, desktop, and UIA prerequisites must be blocking checks.");
        Equal(DoctorStatus.Unsupported, checks[WindowsHostDoctor.PointerInjectionCheck].Status,
            "Pointer injection must remain explicitly unsupported.");
        Equal(DoctorStatus.Unsupported, checks[WindowsHostDoctor.KeyboardInjectionCheck].Status,
            "Keyboard injection must remain explicitly unsupported.");
        Equal(DoctorStatus.Unsupported, checks[WindowsHostDoctor.SecureDesktopCheck].Status,
            "Secure Desktop must remain explicitly unsupported.");
        True(!checks[WindowsHostDoctor.SecureDesktopCheck].Required,
            "Secure Desktop must not block ordinary UIA sessions.");

        Equal(ExpectedOverall(report.Checks), report.Overall,
            "Unsupported optional capabilities must not fail an ordinary UIA session.");
    }

    public static void NdjsonIsMachineReadable()
    {
        const string request =
            "{\"protocolVersion\":\"0.2\",\"id\":\"doctor\",\"method\":\"host.doctor\",\"params\":{}}";
        using var input = new StringReader(request);
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();

        var exitCode = new NdjsonHost(input, output, diagnostics).Run(CancellationToken.None);
        Equal(0, exitCode, "Host must exit cleanly after a doctor request.");
        Equal(string.Empty, diagnostics.ToString(),
            "Expected doctor results belong on stdout, not stderr.");

        using var document = JsonDocument.Parse(output.ToString());
        var root = document.RootElement;
        Equal("doctor", root.GetProperty("id").GetString() ?? string.Empty,
            "Doctor response id must correlate with its request.");
        True(root.GetProperty("ok").GetBoolean(),
            "Environment failures must be checks, not transport failures.");

        var result = root.GetProperty("result");
        True(result.GetProperty("readOnly").GetBoolean(),
            "Serialized doctor result must declare read-only operation.");
        True(result.TryGetProperty("generatedAt", out _),
            "Serialized doctor result must use the Core generatedAt field name.");
        var secureDesktop = result.GetProperty("checks")
            .EnumerateArray()
            .Single(check => string.Equals(
                check.GetProperty("id").GetString(),
                WindowsHostDoctor.SecureDesktopCheck,
                StringComparison.Ordinal));
        Equal("unsupported", secureDesktop.GetProperty("status").GetString() ?? string.Empty,
            "Doctor statuses must serialize to stable camel-case strings.");
        True(!secureDesktop.GetProperty("required").GetBoolean(),
            "Optional security boundaries must serialize their required flag.");
    }

    private static string[] ExpectedCheckIds() =>
    [
        WindowsHostDoctor.OsCheck,
        WindowsHostDoctor.SessionCheck,
        WindowsHostDoctor.InteractiveDesktopCheck,
        WindowsHostDoctor.UiaCheck,
        WindowsHostDoctor.IntegrityBoundaryCheck,
        WindowsHostDoctor.PointerInjectionCheck,
        WindowsHostDoctor.KeyboardInjectionCheck,
        WindowsHostDoctor.SecureDesktopCheck,
    ];

    private static DoctorStatus ExpectedOverall(IEnumerable<DoctorCheck> checks)
    {
        var all = checks.ToArray();
        if (all.Any(check => check.Required && check.Status == DoctorStatus.Fail))
        {
            return DoctorStatus.Fail;
        }
        if (all.Any(check => check.Required && check.Status == DoctorStatus.Unsupported))
        {
            return DoctorStatus.Unsupported;
        }
        return all.Any(check => check.Status is DoctorStatus.Warn or DoctorStatus.Fail)
            ? DoctorStatus.Warn
            : DoctorStatus.Pass;
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
}
