using SurfaceLoom.WindowsHost.Host;

namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>
/// Early, read-only integrity comparison for an external attach target. It rejects only a
/// proven higher-integrity target; an unknown reading keeps the previous attach behaviour
/// because absence of evidence is not proof of a boundary. It never elevates, duplicates a
/// token, or relies on UIAccess.
/// </summary>
public static class IntegrityBoundaryGuard
{
    public const string ElevatedTargetFeature = "windows.elevatedTarget";

    public static void EnsureTargetNotHigher(int processId) =>
        ThrowIfTargetHigher(
            processId,
            WindowsIntegrityLevels.Evaluate(
                WindowsIntegrityLevelReader.ReadCurrentProcess(),
                WindowsIntegrityLevelReader.ReadProcess(processId)));

    internal static void ThrowIfTargetHigher(int processId, IntegrityBoundaryEvaluation evaluation)
    {
        ArgumentNullException.ThrowIfNull(evaluation);
        if (evaluation.Verdict != IntegrityBoundaryVerdict.TargetHigher)
        {
            return;
        }

        throw new HostOperationException(
            "capability_unsupported",
            $"Process {processId} runs at a higher integrity level ({evaluation.Target.Level}) " +
            $"than the host ({evaluation.Host.Level}); UI Automation cannot inspect it across " +
            "this boundary and the host will not elevate or bypass it. Run the target " +
            "non-elevated, or run the host at the target's level only if the test requires it.",
            new
            {
                capability = ElevatedTargetFeature,
                verdict = evaluation.Verdict,
                hostIntegrityLevel = evaluation.Host.Level,
                hostIntegrityRid = evaluation.Host.Rid,
                targetIntegrityLevel = evaluation.Target.Level,
                targetIntegrityRid = evaluation.Target.Rid,
                bypassAttempted = false,
            });
    }
}
