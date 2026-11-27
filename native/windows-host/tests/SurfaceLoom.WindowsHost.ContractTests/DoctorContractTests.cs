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

        var integrity = checks[WindowsHostDoctor.IntegrityBoundaryCheck];
        True(!integrity.Required,
            "Integrity is target-dependent and must not block an elevated CI runner by itself.");
        // The runner's own integrity level is environmental (Medium locally, typically High on an
        // elevated CI runner, System under a service), so compare against an independent read of
        // the same token instead of hard-coding which levels the machine running the test may have.
        var hostReading = WindowsIntegrityLevelReader.ReadCurrentProcess();
        var expectedIntegrity = IntegrityBoundaryDoctorCheck.Create(hostReading);
        Equal(expectedIntegrity.Status, integrity.Status,
            $"Doctor must classify the host's actual token level ({hostReading.Level}).");
        var integrityDetails = JsonSerializer.SerializeToElement(integrity.Details, JsonDefaults.Options);
        True(integrityDetails.GetProperty("hostProbed").GetBoolean(),
            "Doctor must probe the host token instead of emitting a fixed warning.");
        var reportedLevel = integrityDetails.GetProperty("hostIntegrityLevel").GetString() ?? string.Empty;
        Equal(JsonSerializer.SerializeToElement(hostReading.Level, JsonDefaults.Options).GetString() ?? "?",
            reportedLevel, "Doctor must report the real host integrity level.");
        True(reportedLevel is not ("unknown" or "unrecognized"),
            "The host's own token label must be readable and documented.");
        True(!integrityDetails.GetProperty("targetProbed").GetBoolean(),
            "Doctor has no target and must not claim to have probed one.");
        True(!integrityDetails.GetProperty("bypassAttempted").GetBoolean(),
            "Doctor must never attempt an integrity bypass.");
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

    public static void IntegrityStatusMapping()
    {
        var cases = new (WindowsIntegrityReading Reading, DoctorStatus Status, string Level)[]
        {
            (Rid(WindowsIntegrityLevels.UntrustedRid), DoctorStatus.Fail, "untrusted"),
            (Rid(WindowsIntegrityLevels.LowRid), DoctorStatus.Fail, "low"),
            (Rid(WindowsIntegrityLevels.MediumRid), DoctorStatus.Pass, "medium"),
            (Rid(WindowsIntegrityLevels.MediumPlusRid), DoctorStatus.Pass, "mediumPlus"),
            (Rid(WindowsIntegrityLevels.HighRid), DoctorStatus.Warn, "high"),
            (Rid(WindowsIntegrityLevels.SystemRid), DoctorStatus.Fail, "system"),
            (Rid(WindowsIntegrityLevels.ProtectedProcessRid), DoctorStatus.Fail, "protectedProcess"),
            (Rid(0x2050), DoctorStatus.Warn, "unrecognized"),
            (WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.OpenTokenFailed, 5),
                DoctorStatus.Warn, "unknown"),
            (WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.NotWindows),
                DoctorStatus.Warn, "unknown"),
        };
        var requiredPass = new DoctorCheck(WindowsHostDoctor.OsCheck, DoctorStatus.Pass, "ok", true);
        foreach (var (reading, status, level) in cases)
        {
            var check = IntegrityBoundaryDoctorCheck.Create(reading);
            Equal(WindowsHostDoctor.IntegrityBoundaryCheck, check.Id, "Check id must stay stable.");
            Equal(status, check.Status, $"Integrity level '{level}' maps to the wrong status.");
            True(!check.Required, "The integrity check must stay non-required for every reading.");
            True(status == DoctorStatus.Pass || !string.IsNullOrWhiteSpace(check.Remediation),
                $"Non-passing level '{level}' must carry actionable remediation.");
            Equal(status == DoctorStatus.Pass ? DoctorStatus.Pass : DoctorStatus.Warn,
                WindowsHostDoctor.CalculateOverall([requiredPass, check]),
                $"Integrity level '{level}' alone must never make the overall verdict fail.");

            var details = JsonSerializer.SerializeToElement(check.Details, JsonDefaults.Options);
            Equal(level, details.GetProperty("hostIntegrityLevel").GetString() ?? string.Empty,
                "Details must report the classified level.");
            True(details.GetProperty("hostProbed").GetBoolean(), "Details must mark the host as probed.");
            True(!details.GetProperty("targetProbed").GetBoolean(), "Doctor never probes a target.");
            True(!details.GetProperty("bypassAttempted").GetBoolean(), "Doctor never attempts a bypass.");
            Equal(reading.HasRid, details.TryGetProperty("hostIntegrityRid", out _),
                "A RID is reported exactly when one was read.");
            Equal(reading.Win32Error is not null, details.TryGetProperty("hostWin32Error", out _),
                "A Win32 error is reported exactly when a read failed with one.");
        }

        var highRemediation = IntegrityBoundaryDoctorCheck.Create(Rid(WindowsIntegrityLevels.HighRid)).Remediation;
        True(highRemediation?.Contains("non-elevated", StringComparison.Ordinal) == true,
            "Elevated hosts must be told to re-run from a non-elevated terminal.");
    }

    private static WindowsIntegrityReading Rid(uint rid) => WindowsIntegrityReading.FromRid(rid);

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
