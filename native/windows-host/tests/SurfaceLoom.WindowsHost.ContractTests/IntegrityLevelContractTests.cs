using System.Text.Json;
using SurfaceLoom.WindowsHost.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static class IntegrityLevelContractTests
{
    private static readonly (uint Rid, WindowsIntegrityLevel Level)[] DocumentedLevels =
    [
        (0x0000, WindowsIntegrityLevel.Untrusted),
        (0x1000, WindowsIntegrityLevel.Low),
        (0x2000, WindowsIntegrityLevel.Medium),
        (0x2100, WindowsIntegrityLevel.MediumPlus),
        (0x3000, WindowsIntegrityLevel.High),
        (0x4000, WindowsIntegrityLevel.System),
        (0x5000, WindowsIntegrityLevel.ProtectedProcess),
    ];

    public static void RidClassificationIsExact()
    {
        foreach (var (rid, level) in DocumentedLevels)
        {
            Equal(level, WindowsIntegrityLevels.Classify(rid), $"RID 0x{rid:X4} misclassified.");
            var reading = WindowsIntegrityReading.FromRid(rid);
            True(reading.HasRid && reading.Rid == rid, "A read RID must be retained verbatim.");
        }
        foreach (var rid in new uint[]
                 {
                     0x0001, 0x0FFF, 0x1001, 0x1FFF, 0x2001, 0x20FF, 0x2101, 0x2FFF,
                     0x3001, 0x3FFF, 0x4001, 0x4FFF, 0x5001, 0x6000, uint.MaxValue,
                 })
        {
            Equal(WindowsIntegrityLevel.Unrecognized, WindowsIntegrityLevels.Classify(rid),
                $"Undocumented RID 0x{rid:X} must not be rounded to a neighbouring level.");
        }

        var failed = WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.OpenTokenFailed, 5);
        Equal(WindowsIntegrityLevel.Unknown, failed.Level, "A failed read must be unknown.");
        True(!failed.HasRid && failed.Win32Error == 5,
            "A failed read must carry its Win32 error and no RID.");
    }

    public static void HostTargetEvaluationMatrix()
    {
        foreach (var (hostRid, _) in DocumentedLevels)
        {
            foreach (var (targetRid, _) in DocumentedLevels)
            {
                var expected = targetRid > hostRid
                    ? IntegrityBoundaryVerdict.TargetHigher
                    : IntegrityBoundaryVerdict.TargetNotHigher;
                Equal(expected, Evaluate(hostRid, targetRid),
                    $"Host 0x{hostRid:X4} vs target 0x{targetRid:X4} verdict is wrong.");
            }
        }

        Equal(IntegrityBoundaryVerdict.TargetHigher, Evaluate(0x2000, 0x2050),
            "Unrecognized RIDs must still compare numerically like Windows MIC.");
        var unknown = WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.OpenTokenFailed, 5);
        var medium = WindowsIntegrityReading.FromRid(0x2000);
        Equal(IntegrityBoundaryVerdict.HostUnknown,
            WindowsIntegrityLevels.Evaluate(unknown, medium).Verdict,
            "An unreadable host must never yield a boundary conclusion.");
        Equal(IntegrityBoundaryVerdict.HostUnknown,
            WindowsIntegrityLevels.Evaluate(unknown, unknown).Verdict,
            "Host evidence is evaluated first when both sides are unknown.");
        Equal(IntegrityBoundaryVerdict.TargetUnknown,
            WindowsIntegrityLevels.Evaluate(medium, unknown).Verdict,
            "An unreadable target must be explicit, not treated as inspectable.");
    }

    public static void AttachGuardRejectsOnlyProvenHigherTargets()
    {
        True(CapabilityCatalog.Create().Features.ContainsKey(IntegrityBoundaryGuard.ElevatedTargetFeature),
            "The attach guard must reference a declared capability.");
        var high = WindowsIntegrityReading.FromRid(WindowsIntegrityLevels.HighRid);
        var medium = WindowsIntegrityReading.FromRid(WindowsIntegrityLevels.MediumRid);
        var unknown = WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.OpenTokenFailed, 5);

        var exception = Throws<HostOperationException>(() => IntegrityBoundaryGuard.ThrowIfTargetHigher(
            42, WindowsIntegrityLevels.Evaluate(medium, high)));
        Equal("capability_unsupported", exception.Code,
            "A higher-integrity target must be a structured unsupported capability.");
        var details = JsonSerializer.SerializeToElement(exception.Details, JsonDefaults.Options);
        Equal(IntegrityBoundaryGuard.ElevatedTargetFeature,
            details.GetProperty("capability").GetString(), "The error must name the capability.");
        Equal("high", details.GetProperty("targetIntegrityLevel").GetString(),
            "The error must report the target level.");
        Equal("medium", details.GetProperty("hostIntegrityLevel").GetString(),
            "The error must report the host level.");
        True(!details.GetProperty("bypassAttempted").GetBoolean(), "No bypass may be attempted.");

        foreach (var (host, target) in new[] { (high, medium), (medium, medium), (unknown, high), (medium, unknown) })
        {
            IntegrityBoundaryGuard.ThrowIfTargetHigher(42, WindowsIntegrityLevels.Evaluate(host, target));
        }
    }

    public static void CurrentProcessLevelIsReadable()
    {
        var current = WindowsIntegrityLevelReader.ReadCurrentProcess();
        True(current.HasRid, $"Current token label was not readable: {current.Failure} ({current.Win32Error}).");
        True(current.Level is not (WindowsIntegrityLevel.Unknown or WindowsIntegrityLevel.Unrecognized),
            $"Current process RID 0x{current.Rid:X} is not a documented level.");

        var self = WindowsIntegrityLevelReader.ReadProcess(Environment.ProcessId);
        True(self.HasRid && self.Rid == current.Rid,
            $"Limited PID-based read disagrees with the current token: {self.Failure} ({self.Win32Error}).");
        Equal(IntegrityBoundaryVerdict.TargetNotHigher,
            WindowsIntegrityLevels.Evaluate(current, self).Verdict,
            "A process is never above its own integrity level.");
        IntegrityBoundaryGuard.EnsureTargetNotHigher(Environment.ProcessId);

        Equal(WindowsIntegrityReadFailure.InvalidProcessId, WindowsIntegrityLevelReader.ReadProcess(0).Failure,
            "Non-positive PIDs must be rejected without a system call.");
        // Windows drops the low two tag bits of a client ID (0x7FFFFFFC), which lies far beyond
        // the process ID table's capacity, so OpenProcess cannot resolve it to a live process.
        var missing = WindowsIntegrityLevelReader.ReadProcess(int.MaxValue);
        True(!missing.HasRid && missing.Failure == WindowsIntegrityReadFailure.OpenProcessFailed,
            $"A nonexistent PID must be unknown, not a level: {missing.Failure}.");
    }

    private static IntegrityBoundaryVerdict Evaluate(uint hostRid, uint targetRid) =>
        WindowsIntegrityLevels.Evaluate(
            WindowsIntegrityReading.FromRid(hostRid),
            WindowsIntegrityReading.FromRid(targetRid)).Verdict;

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
}
